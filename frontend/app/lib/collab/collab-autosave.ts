import * as Y from 'yjs';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('CollabAutosave');

/**
 * Persisting collaborative edits to the container filesystem.
 *
 * Live co-editing was visible but not durable. A collaborator's keystrokes reach
 * the other peer through the shared `Y.Text` and are rendered by the CodeMirror
 * binding, so both people watch the file change — but nothing wrote that content to
 * disk. The only paths to the container are the explicit save (`Ctrl+S` / the save
 * button, `workbenchStore.saveFile`) and an AI action, and neither runs for typing.
 * So the dev server never rebuilt from a co-edit, and the next reload re-seeded the
 * doc from disk and lost every one of them.
 *
 * Saving is deliberately not restricted to the peer who typed. Both peers share one
 * container, so either can persist the same bytes: whichever debounce fires first
 * writes, and the other then finds disk already matching and skips. The redundancy
 * is the point — a collaborator who closes their tab mid-edit still has their work
 * written by whoever is left.
 *
 * Debounced rather than immediate because every write produces a container file
 * event, which republishes the whole file map to the editor. That is cheap now that
 * `EditorStore.setDocuments` preserves dirty buffers (TEST_REPORT defect 18), but
 * one write per keystroke would still be a write per keystroke.
 */
const FILES_PREFIX = 'files:';

/** Long enough to coalesce a burst of typing, short enough to feel automatic. */
const DEFAULT_DELAY_MS = 800;

export interface CollabAutosaveDeps {
  /**
   * The container's current content for a path, or undefined if it has no such
   * file. Undefined means skip: writing would resurrect a deleted file, or invent
   * one the files store has never seen.
   */
  diskContent: (filePath: string) => string | undefined;

  /** Write content to the container. */
  save: (filePath: string, content: string) => Promise<void>;

  /** Debounce window. */
  delayMs?: number;
}

/** The file path a root type name refers to, or null if it is not a file. */
function filePathFromSharedName(name: string): string | null {
  return name.startsWith(FILES_PREFIX) ? name.slice(FILES_PREFIX.length) : null;
}

/**
 * Root-type name for a changed type.
 *
 * Yjs reports transaction changes as types, not names, so the name has to come
 * from the doc's own root registry. Nested types are absent from it and yield
 * undefined, which is correct: only root `files:<path>` texts are files.
 */
function sharedNameOf(doc: Y.Doc, type: Y.AbstractType<any>): string | undefined {
  for (const [name, shared] of doc.share) {
    if (shared === type) {
      return name;
    }
  }

  return undefined;
}

/**
 * Write every change to a shared file text through to the container, debounced per
 * path. Returns a teardown that cancels pending writes.
 */
export function startCollabAutosave(doc: Y.Doc, deps: CollabAutosaveDeps): () => void {
  const delayMs = deps.delayMs ?? DEFAULT_DELAY_MS;
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  let stopped = false;

  const flush = async (filePath: string) => {
    pending.delete(filePath);

    if (stopped) {
      return;
    }

    const content = doc.getText(`${FILES_PREFIX}${filePath}`).toString();
    const onDisk = deps.diskContent(filePath);

    /**
     * Undefined: no such file. Equal: either the seed we just applied from disk, or
     * a peer has already written this content — nothing to do either way.
     */
    if (onDisk === undefined || onDisk === content) {
      return;
    }

    try {
      await deps.save(filePath, content);
    } catch (err) {
      /**
       * Best-effort: the edit is still live in the CRDT and in both editors, and the
       * next keystroke schedules another attempt. Failing loudly here would put a
       * toast on screen for something the user cannot act on.
       */
      logger.warn(`Could not persist a collaborative edit to ${filePath}:`, err);
    }
  };

  const schedule = (filePath: string) => {
    const existing = pending.get(filePath);

    if (existing) {
      clearTimeout(existing);
    }

    pending.set(
      filePath,
      setTimeout(() => void flush(filePath), delayMs),
    );
  };

  const onAfterTransaction = (transaction: Y.Transaction) => {
    for (const type of transaction.changed.keys()) {
      const name = sharedNameOf(doc, type);
      const filePath = name ? filePathFromSharedName(name) : null;

      if (filePath) {
        schedule(filePath);
      }
    }
  };

  doc.on('afterTransaction', onAfterTransaction);

  return () => {
    stopped = true;
    doc.off('afterTransaction', onAfterTransaction);

    for (const timer of pending.values()) {
      clearTimeout(timer);
    }

    pending.clear();
  };
}

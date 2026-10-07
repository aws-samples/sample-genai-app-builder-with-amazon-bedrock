import type { Extension } from '@codemirror/state';
import * as Y from 'yjs';
import { yCollab } from 'y-codemirror.next';
import type { CollabProvider } from './collab-provider';

/**
 * Per-file collaborative binding for CodeMirror.
 *
 * A single shared `Y.Doc` (owned by the {@link CollabProvider}) holds one
 * `Y.Text` per file, keyed by file path as a top-level (root) type named
 * `files:<path>`. Root types are canonical and idempotent — `doc.getText(name)`
 * always returns the same shared instance — so every open file in the project
 * shares one CRDT document and one presence channel, while each editor view
 * binds only to its file's `Y.Text`.
 *
 * Why root types and not a `Y.Map` of texts: a `Y.Text` obtained from
 * `doc.getText()` is already integrated at the doc root and cannot be nested
 * inside a `Y.Map` (Yjs integrates a type exactly once). Root texts also
 * converge on concurrent first-open, whereas two peers each `set()`-ing a fresh
 * `new Y.Text()` into a map would race and orphan one peer's content.
 *
 * Seeding: the FIRST client to open a file must seed its `Y.Text` from the
 * container's file content. The subtle case is two peers cold-opening the same
 * file BEFORE their first sync crosses — each sees an empty doc and seeds
 * independently. A plain `ytext.insert()` stamps the insert with the local
 * client id, so two such inserts have distinct identities and the CRDT merge
 * CONCATENATES them, duplicating the file. A `meta`-flag guard cannot prevent
 * this: neither peer has seen the other's flag yet.
 *
 * So we seed DETERMINISTICALLY: build the initial content in a throwaway doc
 * pinned to a fixed reserved client id and clock, encode it as an update, and
 * apply that update. Two peers seeding identical content emit byte-identical
 * structs (same client, same clock, same chars), which Yjs recognises as the
 * SAME operation and collapses to a single copy — regardless of join order and
 * with no leader election. A peer that already has the text (via sync or a
 * prior seed) applies a no-op, so seeding stays idempotent.
 */
const FILES_PREFIX = 'files:';

/**
 * Seed structs are stamped with a reserved client id lifted above 2^32. Yjs
 * assigns live clients from `random.uint32()` (always < 2^32), so a seed client
 * can never collide with a real editing client — its struct stream stays
 * private to seeding.
 */
const SEED_CLIENT_BASE = 0x1_0000_0000; // 2^32

/**
 * Deterministic seed client id for a file path. Each path gets its own client
 * (via an FNV-1a hash) so distinct files seed into separate struct streams and
 * never clobber one another; identical paths across peers get the SAME client,
 * so their seeds are byte-identical and dedupe to one copy. Result is in
 * [2^32, 2^33) — reserved, and safely within JS integer range.
 */
function seedClientId(filePath: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < filePath.length; i++) {
    hash ^= filePath.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return SEED_CLIENT_BASE + (hash >>> 0);
}

export interface CollabBinding {
  extension: Extension;
  ytext: Y.Text;
}

/**
 * Build the canonical seed update for a file: the content inserted by the
 * path's reserved seed client at clock 0. Deterministic — the same (filePath,
 * fileContent) always yields the same bytes on every peer.
 */
function encodeSeedUpdate(filePath: string, fileContent: string): Uint8Array {
  const seedDoc = new Y.Doc();
  seedDoc.clientID = seedClientId(filePath);
  seedDoc.getText(`${FILES_PREFIX}${filePath}`).insert(0, fileContent);
  return Y.encodeStateAsUpdate(seedDoc);
}

/**
 * Get (or create) the shared `Y.Text` for a file and seed it from
 * `fileContent` if it is still empty. Safe to call concurrently across peers
 * and repeatedly on one peer — see the deterministic-seed note above.
 */
export function getFileText(doc: Y.Doc, filePath: string, fileContent: string): Y.Text {
  // The canonical root text for this file. Repeated calls (and concurrent
  // opens across peers) all resolve to the same shared instance.
  const ytext = doc.getText(`${FILES_PREFIX}${filePath}`);

  // Only the first opener seeds. Applying the deterministic seed update is a
  // no-op for any peer that already integrated it, so concurrent seeds and
  // re-opens converge on exactly one copy.
  if (ytext.length === 0 && fileContent.length > 0) {
    Y.applyUpdate(doc, encodeSeedUpdate(filePath, fileContent));
  }

  return ytext;
}

/**
 * Build the CodeMirror extension that binds an editor view to the shared
 * `Y.Text` for `filePath`, including remote cursors/selections via the
 * provider's Awareness instance.
 */
export function createCollabBinding(
  provider: CollabProvider,
  filePath: string,
  fileContent: string,
): CollabBinding {
  const ytext = getFileText(provider.doc, filePath, fileContent);

  // yCollab wires document sync AND remote selection rendering off the shared
  // awareness channel. Passing `undefined` for the undo manager keeps Yjs'
  // default per-client undo scoping.
  const extension = yCollab(ytext, provider.awareness, { undoManager: false });

  return { extension, ytext };
}

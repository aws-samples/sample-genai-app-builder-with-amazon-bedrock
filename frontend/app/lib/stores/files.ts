import { map, type MapStore } from 'nanostores';
import * as nodePath from 'node:path';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { RuntimeConnection, FileChangeEvent } from '~/lib/runtime/types';
import { setSessionStatus } from '~/lib/runtime/session-status';
import { WORK_DIR } from '~/utils/constants';

const logger = createScopedLogger('FilesStore');

export interface File {
  type: 'file';
  content: string;
  isBinary: boolean;
}

export interface Folder {
  type: 'folder';
}

type Dirent = File | Folder;

export type FileMap = Record<string, Dirent | undefined>;

export class FilesStore {
  /** Resolve a healthy connection on demand; see {@link getConnection}. */
  #connect: () => Promise<RuntimeConnection>;

  /**
   * Tracks the number of files without folders.
   */
  #size = 0;

  /**
   * @note Keeps track all modified files with their original content since the last user message.
   * Needs to be reset when the user sends another message and all changes have to be submitted
   * for the model to be aware of the changes.
   */
  #modifiedFiles: Map<string, string> = import.meta.hot?.data.modifiedFiles ?? new Map();

  /**
   * Map of files that matches the state of the container filesystem.
   */
  files: MapStore<FileMap> = import.meta.hot?.data.files ?? map({});

  get filesCount() {
    return this.#size;
  }

  constructor(connect: () => Promise<RuntimeConnection>) {
    this.#connect = connect;

    if (import.meta.hot) {
      import.meta.hot.data.files = this.files;
      import.meta.hot.data.modifiedFiles = this.#modifiedFiles;
    }

    this.#init();
  }

  getFile(filePath: string) {
    const dirent = this.files.get()[filePath];

    if (dirent?.type !== 'file') {
      return undefined;
    }

    return dirent;
  }

  getFileModifications() {
    return computeFileModifications(this.files.get(), this.#modifiedFiles);
  }

  resetFileModifications() {
    this.#modifiedFiles.clear();
  }

  async saveFile(filePath: string, content: string) {
    const conn = await this.#connect();

    try {
      const relativePath = filePath.replace(/^\/home\/sandbox\/project\/?/, '');

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${filePath}'`);
      }

      const oldContent = this.getFile(filePath)?.content;

      // Empty is a legitimate content, not a missing file. Guarding on falsiness
      // refused to write any file that happened to be empty — routine once
      // collaborative edits are auto-saved, since a newly created file starts empty.
      if (oldContent === undefined) {
        unreachable('Expected content to be defined');
      }

      await conn.request({
        type: 'fs:write:req',
        payload: { path: relativePath, content, encoding: 'utf8' },
      });

      if (!this.#modifiedFiles.has(filePath)) {
        this.#modifiedFiles.set(filePath, oldContent);
      }

      this.files.setKey(filePath, { type: 'file', content, isBinary: false });

      logger.info('File updated');
    } catch (error) {
      logger.error('Failed to update file content\n\n', error);

      throw error;
    }
  }

  /**
   * Absolute store path for a path reported by the sidecar.
   *
   * The agent speaks in paths relative to the container's workspace
   * (`package.json`, `src/App.jsx`), while this store — and the file tree, which
   * filters on `WORK_DIR` — key off absolute ones. Prefixing with only `/` left
   * every entry outside the tree's root, so a fully populated project rendered as
   * an empty Files panel.
   */
  #toStorePath(reportedPath: string): string {
    if (reportedPath.startsWith(WORK_DIR)) {
      return reportedPath;
    }

    return `${WORK_DIR}/${reportedPath.replace(/^\/+/, '')}`;
  }

  async #init() {
    // Resolving the connection can fail if the sandbox boot lost the page-load
    // race (auth not hydrated yet). Retry rather than give up: a one-shot await
    // here is exactly what used to leave a reopened project with a permanently
    // empty file tree — nothing else re-syncs it. #connect() re-boots on each
    // call, so successive attempts get progressively warmer state.
    let conn: RuntimeConnection | undefined;

    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        conn = await this.#connect();
        break;
      } catch (err) {
        logger.warn(`File store connect attempt ${attempt}/5 failed:`, err);

        if (attempt === 5) {
          logger.error('File store could not connect; the file tree will stay empty until retry.');
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, Math.min(400 * 2 ** (attempt - 1), 3000)));
      }
    }

    if (!conn) {
      return;
    }

    // Subscribe to file change events from the sidecar's chokidar watcher
    conn.on('fs:change:event', (msg) => {
      const event = msg as unknown as FileChangeEvent;
      const { eventType, path, content, isBinary } = event.payload;

      const fullPath = this.#toStorePath(path);

      switch (eventType) {
        case 'add_dir':
          this.files.setKey(fullPath, { type: 'folder' });
          break;
        case 'remove_dir':
          this.files.setKey(fullPath, undefined);
          for (const [direntPath] of Object.entries(this.files.get())) {
            if (direntPath.startsWith(fullPath)) {
              this.files.setKey(direntPath, undefined);
            }
          }
          break;
        case 'add_file':
          this.#size++;
          // fall through
        case 'change': {
          let fileContent = '';
          if (content && !isBinary) {
            try {
              fileContent = atob(content);
            } catch {
              fileContent = content;
            }
          }
          this.files.setKey(fullPath, { type: 'file', content: fileContent, isBinary: !!isBinary });
          break;
        }
        case 'remove_file':
          this.#size--;
          this.files.setKey(fullPath, undefined);
          break;
      }
    });

    // Initial file sync
    try {
      const syncRes = await conn.request({
        type: 'fs:sync:req' as any,
        payload: {
          include: ['**'],
          exclude: ['**/node_modules', '.git'],
          includeContent: true,
        },
      });
      const files = (syncRes.payload as any)?.files || [];
      for (const file of files) {
        const fullPath = this.#toStorePath(file.path);
        // The sidecar reports directories as 'directory' (see FsSyncFile in the
        // agent protocol); this store models them as 'folder'. Accept both so a
        // directory is never mistaken for an empty file — which used to leave a
        // freshly-hydrated tree full of bogus zero-byte entries.
        if (file.type === 'folder' || file.type === 'directory') {
          this.files.setKey(fullPath, { type: 'folder' });
        } else {
          this.#size++;
          let content = '';
          if (file.content && !file.isBinary) {
            try {
              content = atob(file.content);
            } catch {
              content = file.content;
            }
          }
          this.files.setKey(fullPath, { type: 'file', content, isBinary: !!file.isBinary });
        }
      }
    } catch (err) {
      logger.debug('Initial file sync skipped:', err);
    } finally {
      // The workbench is now populated (or the owner's container is genuinely
      // empty). Either way the "connecting to shared session" state is done —
      // clear it so the file tree and editor show instead of a spinner.
      setSessionStatus('ready');
    }
  }
}

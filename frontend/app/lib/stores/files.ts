import { map, type MapStore } from 'nanostores';
import * as nodePath from 'node:path';
import { computeFileModifications } from '~/utils/diff';
import { createScopedLogger } from '~/utils/logger';
import { unreachable } from '~/utils/unreachable';
import type { RuntimeConnection, FileChangeEvent } from '~/lib/runtime/types';

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
  #connection: Promise<RuntimeConnection>;

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

  constructor(connectionPromise: Promise<RuntimeConnection>) {
    this.#connection = connectionPromise;

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
    const conn = await this.#connection;

    try {
      const relativePath = filePath.replace(/^\/home\/sandbox\/project\/?/, '');

      if (!relativePath) {
        throw new Error(`EINVAL: invalid file path, write '${filePath}'`);
      }

      const oldContent = this.getFile(filePath)?.content;

      if (!oldContent) {
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

  async #init() {
    const conn = await this.#connection;

    // Subscribe to file change events from the sidecar's chokidar watcher
    conn.on('fs:change:event', (msg) => {
      const event = msg as unknown as FileChangeEvent;
      const { eventType, path, content, isBinary } = event.payload;

      // Prefix path to match store convention
      const fullPath = path.startsWith('/') ? path : `/${path}`;

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
        const fullPath = file.path.startsWith('/') ? file.path : `/${file.path}`;
        if (file.type === 'folder') {
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
    }
  }
}

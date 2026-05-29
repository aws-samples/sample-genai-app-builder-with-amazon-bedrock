import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { createEvent, type WSEvent } from './protocol.js';

const WORKDIR = process.env.WORKDIR ?? '/home/sandbox/project';

// Binary file extensions – same list as filesystem handler
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.7z',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib',
]);

function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export type EventEmitter = (event: WSEvent) => void;

/**
 * Watches the working directory for file changes and emits fs:change:event messages.
 */
export class FileWatcher {
  private watcher: FSWatcher | null = null;
  private emit: EventEmitter;
  private workdir: string;

  constructor(emit: EventEmitter, workdir: string = WORKDIR) {
    this.emit = emit;
    this.workdir = workdir;
  }

  /**
   * Start watching the workdir for file changes.
   */
  start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.workdir, {
      ignored: [
        '**/node_modules/**',
        '**/.git/**',
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher.on('add', (filePath: string) => this.handleFileEvent('add_file', filePath));
    this.watcher.on('change', (filePath: string) => this.handleFileEvent('change', filePath));
    this.watcher.on('unlink', (filePath: string) => this.handleFileEvent('remove_file', filePath));
    this.watcher.on('addDir', (dirPath: string) => this.handleDirEvent('add_dir', dirPath));
    this.watcher.on('unlinkDir', (dirPath: string) => this.handleDirEvent('remove_dir', dirPath));
  }

  /**
   * Handle a directory event from chokidar.
   */
  private handleDirEvent(eventType: 'add_dir' | 'remove_dir', dirPath: string): void {
    const relativePath = path.relative(this.workdir, dirPath);

    // Skip the root workdir itself
    if (!relativePath) return;

    this.emit(createEvent('fs:change:event', {
      eventType,
      path: relativePath,
    }));
  }

  /**
   * Handle a single file event from chokidar.
   */
  private async handleFileEvent(eventType: 'add_file' | 'change' | 'remove_file', filePath: string): Promise<void> {
    const relativePath = path.relative(this.workdir, filePath);

    const payload: Record<string, unknown> = {
      eventType,
      path: relativePath,
    };

    // Include content for add and change events (not remove)
    if (eventType !== 'remove_file') {
      try {
        const binary = isBinaryPath(filePath);
        payload.isBinary = binary;

        if (binary) {
          const buffer = await fs.readFile(filePath);
          payload.content = buffer.toString('base64');
        } else {
          payload.content = await fs.readFile(filePath, 'utf-8');
        }
      } catch {
        // File may have been deleted between the event and the read
        payload.content = null;
      }
    }

    this.emit(createEvent('fs:change:event', payload));
  }

  /**
   * Stop watching and release resources.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
  }
}

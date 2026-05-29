import { randomUUID } from 'node:crypto';
import type { IPty } from 'node-pty';
import {
  createResponse,
  createEvent,
  type WSMessage,
  type WSResponse,
  type WSEvent,
  type TerminalCreatePayload,
  type TerminalInputPayload,
  type TerminalResizePayload,
  type TerminalClosePayload,
} from '../protocol.js';

const WORKDIR = process.env.WORKDIR ?? '/home/sandbox/project';

export interface TerminalInstance {
  id: string;
  pty: IPty;
}

export type EventEmitter = (event: WSEvent) => void;

/**
 * Manages PTY-backed terminal instances.
 */
export class TerminalManager {
  private terminals: Map<string, TerminalInstance> = new Map();
  private emit: EventEmitter;
  private ptySpawn: typeof import('node-pty').spawn;

  constructor(emit: EventEmitter, ptySpawn?: typeof import('node-pty').spawn) {
    this.emit = emit;
    // Lazy-load node-pty so tests can inject a mock
    if (ptySpawn) {
      this.ptySpawn = ptySpawn;
    } else {
      // Will be set on first use
      this.ptySpawn = undefined as unknown as typeof import('node-pty').spawn;
    }
  }

  private async getPtySpawn(): Promise<typeof import('node-pty').spawn> {
    if (!this.ptySpawn) {
      const nodePty = await import('node-pty');
      this.ptySpawn = nodePty.spawn;
    }
    return this.ptySpawn;
  }

  /**
   * Handle terminal:create:req – spawn a new PTY.
   */
  async handleCreate(msg: WSMessage): Promise<WSResponse> {
    const payload = msg.payload as unknown as TerminalCreatePayload;
    const terminalId = randomUUID();

    const cols = payload.cols ?? 80;
    const rows = payload.rows ?? 24;
    const shell = payload.shell ?? process.env.SHELL ?? '/bin/bash';
    const cwd = payload.cwd ?? WORKDIR;
    const env = { ...process.env, ...(payload.env ?? {}) } as Record<string, string>;

    const spawn = await this.getPtySpawn();
    const pty = spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
    });

    // Forward PTY output as base64-encoded events
    pty.onData((data: string) => {
      this.emit(
        createEvent('terminal:output:event', {
          terminalId,
          data: Buffer.from(data).toString('base64'),
        })
      );
    });

    // Forward PTY exit events
    pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.emit(
        createEvent('terminal:exit:event', {
          terminalId,
          exitCode,
        })
      );
      this.terminals.delete(terminalId);
    });

    this.terminals.set(terminalId, { id: terminalId, pty });

    return createResponse(msg.id, 'terminal:create:res', { terminalId });
  }

  /**
   * Handle terminal:input:req – write data to a PTY.
   */
  handleInput(msg: WSMessage): WSResponse {
    const payload = msg.payload as unknown as TerminalInputPayload;

    if (!payload.terminalId) {
      throw new Error('Missing required field: terminalId');
    }

    const instance = this.terminals.get(payload.terminalId);
    if (!instance) {
      throw new Error(`Terminal not found: ${payload.terminalId}`);
    }

    const decoded = Buffer.from(payload.data, 'base64').toString('utf-8');
    instance.pty.write(decoded);

    return createResponse(msg.id, 'terminal:input:res', { success: true });
  }

  /**
   * Handle terminal:resize:req – resize a PTY.
   */
  handleResize(msg: WSMessage): WSResponse {
    const payload = msg.payload as unknown as TerminalResizePayload;

    if (!payload.terminalId) {
      throw new Error('Missing required field: terminalId');
    }

    const instance = this.terminals.get(payload.terminalId);
    if (!instance) {
      throw new Error(`Terminal not found: ${payload.terminalId}`);
    }

    instance.pty.resize(payload.cols, payload.rows);

    return createResponse(msg.id, 'terminal:resize:res', { success: true });
  }

  /**
   * Handle terminal:close:req – kill a PTY.
   */
  handleClose(msg: WSMessage): void {
    const payload = msg.payload as unknown as TerminalClosePayload;

    if (!payload.terminalId) {
      throw new Error('Missing required field: terminalId');
    }

    const instance = this.terminals.get(payload.terminalId);
    if (!instance) {
      return; // Already closed, silently ignore
    }

    instance.pty.kill();
    this.terminals.delete(payload.terminalId);
  }

  /**
   * Kill all active terminals. Called on WebSocket disconnect.
   */
  destroyAll(): void {
    for (const [id, instance] of this.terminals) {
      try {
        instance.pty.kill();
      } catch {
        // Terminal may already be dead
      }
      this.terminals.delete(id);
    }
  }

  /**
   * Get the number of active terminals.
   */
  get size(): number {
    return this.terminals.size;
  }

  /**
   * Route a terminal:* message to the correct handler.
   */
  async handle(msg: WSMessage): Promise<WSResponse | void> {
    const action = msg.type.split(':')[1];

    switch (action) {
      case 'create':
        return this.handleCreate(msg);
      case 'input':
        return this.handleInput(msg);
      case 'resize':
        return this.handleResize(msg);
      case 'close':
        return this.handleClose(msg);
      default:
        throw new Error(`Unknown terminal action: ${action}`);
    }
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { TerminalManager } from '../src/handlers/terminal.js';
import type { WSMessage, WSEvent } from '../src/protocol.js';

function makeMsg(type: string, payload: Record<string, unknown>): WSMessage {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

// Mock node-pty instance
function createMockPty() {
  const onDataCallbacks: Array<(data: string) => void> = [];
  const onExitCallbacks: Array<(e: { exitCode: number }) => void> = [];

  return {
    pid: 12345,
    onData: vi.fn((cb: (data: string) => void) => {
      onDataCallbacks.push(cb);
      return { dispose: vi.fn() };
    }),
    onExit: vi.fn((cb: (e: { exitCode: number }) => void) => {
      onExitCallbacks.push(cb);
      return { dispose: vi.fn() };
    }),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    // Helpers for test simulation
    _simulateData(data: string) {
      onDataCallbacks.forEach((cb) => cb(data));
    },
    _simulateExit(exitCode: number) {
      onExitCallbacks.forEach((cb) => cb({ exitCode }));
    },
  };
}

// Mock spawn function
function createMockSpawn() {
  const mockPty = createMockPty();
  const spawnFn = vi.fn().mockReturnValue(mockPty);
  return { spawnFn, mockPty };
}

describe('TerminalManager', () => {
  let events: WSEvent[];
  let emit: (event: WSEvent) => void;

  beforeEach(() => {
    events = [];
    emit = (event: WSEvent) => events.push(event);
  });

  describe('create', () => {
    it('creates a terminal and returns a terminalId', async () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const msg = makeMsg('terminal:create:req', {});
      const res = await manager.handleCreate(msg);

      expect(res.type).toBe('terminal:create:res');
      expect(res.requestId).toBe(msg.id);
      expect(res.payload.terminalId).toBeDefined();
      expect(typeof res.payload.terminalId).toBe('string');
      expect(spawnFn).toHaveBeenCalledOnce();
    });

    it('passes cols, rows, and shell to the PTY', async () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const msg = makeMsg('terminal:create:req', {
        cols: 120,
        rows: 40,
        shell: '/bin/zsh',
      });
      await manager.handleCreate(msg);

      expect(spawnFn).toHaveBeenCalledWith(
        '/bin/zsh',
        [],
        expect.objectContaining({ cols: 120, rows: 40 })
      );
    });

    it('increments terminal count', async () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      expect(manager.size).toBe(0);

      await manager.handleCreate(makeMsg('terminal:create:req', {}));
      expect(manager.size).toBe(1);

      // Create a second mock for the second terminal
      const mockPty2 = createMockPty();
      spawnFn.mockReturnValueOnce(mockPty2);

      await manager.handleCreate(makeMsg('terminal:create:req', {}));
      expect(manager.size).toBe(2);
    });
  });

  describe('output events', () => {
    it('emits terminal:output:event with base64 data when PTY produces output', async () => {
      const { spawnFn, mockPty } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const res = await manager.handleCreate(makeMsg('terminal:create:req', {}));
      const terminalId = res.payload.terminalId as string;

      // Simulate PTY output
      mockPty._simulateData('Hello from PTY');

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('terminal:output:event');
      expect(events[0].payload.terminalId).toBe(terminalId);
      // Verify base64 encoding
      const decoded = Buffer.from(events[0].payload.data as string, 'base64').toString('utf-8');
      expect(decoded).toBe('Hello from PTY');
    });
  });

  describe('exit events', () => {
    it('emits terminal:exit:event when PTY exits', async () => {
      const { spawnFn, mockPty } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const res = await manager.handleCreate(makeMsg('terminal:create:req', {}));
      const terminalId = res.payload.terminalId as string;

      mockPty._simulateExit(0);

      expect(events.length).toBe(1);
      expect(events[0].type).toBe('terminal:exit:event');
      expect(events[0].payload.terminalId).toBe(terminalId);
      expect(events[0].payload.exitCode).toBe(0);

      // Terminal should be removed from the manager
      expect(manager.size).toBe(0);
    });
  });

  describe('input', () => {
    it('writes base64-decoded data to the PTY', async () => {
      const { spawnFn, mockPty } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const createRes = await manager.handleCreate(makeMsg('terminal:create:req', {}));
      const terminalId = createRes.payload.terminalId as string;

      const inputData = Buffer.from('ls -la\n').toString('base64');
      const msg = makeMsg('terminal:input:req', { terminalId, data: inputData });
      const res = manager.handleInput(msg);

      expect(res.type).toBe('terminal:input:res');
      expect(res.payload.success).toBe(true);
      expect(mockPty.write).toHaveBeenCalledWith('ls -la\n');
    });

    it('throws for unknown terminalId', () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const msg = makeMsg('terminal:input:req', {
        terminalId: 'nonexistent',
        data: Buffer.from('x').toString('base64'),
      });

      expect(() => manager.handleInput(msg)).toThrow('Terminal not found');
    });
  });

  describe('resize', () => {
    it('resizes the PTY', async () => {
      const { spawnFn, mockPty } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const createRes = await manager.handleCreate(makeMsg('terminal:create:req', {}));
      const terminalId = createRes.payload.terminalId as string;

      const msg = makeMsg('terminal:resize:req', { terminalId, cols: 200, rows: 50 });
      const res = manager.handleResize(msg);

      expect(res.type).toBe('terminal:resize:res');
      expect(res.payload.success).toBe(true);
      expect(mockPty.resize).toHaveBeenCalledWith(200, 50);
    });
  });

  describe('close', () => {
    it('kills the PTY and removes it', async () => {
      const { spawnFn, mockPty } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const createRes = await manager.handleCreate(makeMsg('terminal:create:req', {}));
      const terminalId = createRes.payload.terminalId as string;

      expect(manager.size).toBe(1);

      manager.handleClose(makeMsg('terminal:close:req', { terminalId }));

      expect(mockPty.kill).toHaveBeenCalledOnce();
      expect(manager.size).toBe(0);
    });

    it('silently ignores already-closed terminal', () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      // Should not throw
      manager.handleClose(makeMsg('terminal:close:req', { terminalId: 'gone' }));
    });
  });

  describe('destroyAll', () => {
    it('kills all terminals', async () => {
      const mockPty1 = createMockPty();
      const mockPty2 = createMockPty();
      const spawnFn = vi.fn()
        .mockReturnValueOnce(mockPty1)
        .mockReturnValueOnce(mockPty2);

      const manager = new TerminalManager(emit, spawnFn as any);

      await manager.handleCreate(makeMsg('terminal:create:req', {}));
      await manager.handleCreate(makeMsg('terminal:create:req', {}));
      expect(manager.size).toBe(2);

      manager.destroyAll();

      expect(manager.size).toBe(0);
      expect(mockPty1.kill).toHaveBeenCalled();
      expect(mockPty2.kill).toHaveBeenCalled();
    });
  });

  describe('handle (router)', () => {
    it('routes create messages', async () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const msg = makeMsg('terminal:create:req', {});
      const res = await manager.handle(msg);
      expect(res).toBeDefined();
      expect((res as any).type).toBe('terminal:create:res');
    });

    it('throws for unknown action', async () => {
      const { spawnFn } = createMockSpawn();
      const manager = new TerminalManager(emit, spawnFn as any);

      const msg = makeMsg('terminal:unknown:req', {});
      await expect(manager.handle(msg)).rejects.toThrow('Unknown terminal action');
    });
  });
});

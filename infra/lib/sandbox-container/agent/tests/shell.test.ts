import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ShellManager } from '../src/handlers/shell.js';
import type { WSMessage, WSEvent } from '../src/protocol.js';

function makeMsg(type: string, payload: Record<string, unknown>): WSMessage {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

describe('ShellManager', () => {
  let events: WSEvent[];
  let emit: (event: WSEvent) => void;
  let manager: ShellManager;
  let tmpDir: string;

  beforeEach(async () => {
    events = [];
    emit = (event: WSEvent) => events.push(event);
    manager = new ShellManager(emit);
    // Use a real temp dir as the working directory for tests
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-shell-test-'));
    process.env.WORKDIR = tmpDir;
  });

  afterEach(async () => {
    manager.destroyAll();
    delete process.env.WORKDIR;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('exec', () => {
    it('runs a simple command and returns stdout', async () => {
      const msg = makeMsg('shell:exec:req', { command: 'echo hello', cwd: tmpDir });
      const res = await manager.handleExec(msg);

      expect(res.type).toBe('shell:exec:res');
      expect(res.requestId).toBe(msg.id);
      expect(res.payload.exitCode).toBe(0);
      expect((res.payload.stdout as string).trim()).toBe('hello');
      expect(res.payload.stderr).toBe('');
      expect(typeof res.payload.processId).toBe('number');
    });

    it('captures stderr', async () => {
      const msg = makeMsg('shell:exec:req', { command: 'echo error >&2', cwd: tmpDir });
      const res = await manager.handleExec(msg);

      expect(res.payload.exitCode).toBe(0);
      expect((res.payload.stderr as string).trim()).toBe('error');
    });

    it('returns non-zero exit code for failed commands', async () => {
      const msg = makeMsg('shell:exec:req', { command: 'exit 42', cwd: tmpDir });
      const res = await manager.handleExec(msg);

      expect(res.payload.exitCode).toBe(42);
    });

    it('runs command with custom cwd', async () => {
      const msg = makeMsg('shell:exec:req', { command: 'pwd', cwd: '/tmp' });
      const res = await manager.handleExec(msg);

      // On macOS /tmp is a symlink to /private/tmp
      const stdout = (res.payload.stdout as string).trim();
      expect(stdout === '/tmp' || stdout === '/private/tmp').toBe(true);
    });

    it('runs command with custom env', async () => {
      const msg = makeMsg('shell:exec:req', {
        command: 'echo $MY_TEST_VAR',
        env: { MY_TEST_VAR: 'custom_value' },
        cwd: tmpDir,
      });
      const res = await manager.handleExec(msg);

      expect((res.payload.stdout as string).trim()).toBe('custom_value');
    });

    it('kills process after timeout', async () => {
      const msg = makeMsg('shell:exec:req', {
        command: 'sleep 30',
        timeout: 200,
        cwd: tmpDir,
      });
      const start = Date.now();
      const res = await manager.handleExec(msg);
      const elapsed = Date.now() - start;

      expect(res.payload.exitCode).toBe(-1);
      // Should complete well before 30 seconds
      expect(elapsed).toBeLessThan(5000);
    });

    it('emits shell:output:event while running', async () => {
      const msg = makeMsg('shell:exec:req', { command: 'echo streamed', cwd: tmpDir });
      await manager.handleExec(msg);

      const stdoutEvents = events.filter(
        (e) => e.type === 'shell:output:event' && e.payload.stream === 'stdout'
      );
      expect(stdoutEvents.length).toBeGreaterThan(0);
      const combined = stdoutEvents.map((e) => e.payload.data).join('');
      expect(combined.trim()).toBe('streamed');
    });

    it('rejects missing command', async () => {
      const msg = makeMsg('shell:exec:req', {});
      await expect(manager.handleExec(msg)).rejects.toThrow('Missing required field: command');
    });
  });

  describe('kill', () => {
    it('throws for unknown processId', () => {
      const msg = makeMsg('shell:kill:req', { processId: 999999 });
      expect(() => manager.handleKill(msg)).toThrow('Process not found');
    });
  });

  describe('handle (router)', () => {
    it('routes exec messages', async () => {
      const msg = makeMsg('shell:exec:req', { command: 'echo routed', cwd: tmpDir });
      const res = await manager.handle(msg);
      expect(res.type).toBe('shell:exec:res');
    });

    it('throws for unknown action', async () => {
      const msg = makeMsg('shell:unknown:req', {});
      await expect(manager.handle(msg)).rejects.toThrow('Unknown shell action');
    });
  });

  describe('setEmitter', () => {
    it('routes output events through the new emitter', async () => {
      const eventsA: WSEvent[] = [];
      const eventsB: WSEvent[] = [];
      const emitA = (event: WSEvent) => eventsA.push(event);
      const emitB = (event: WSEvent) => eventsB.push(event);

      const mgr = new ShellManager(emitA);

      // Run a command — events should go to emitter A
      const msg1 = makeMsg('shell:exec:req', { command: 'echo alpha', cwd: tmpDir });
      await mgr.handleExec(msg1);

      expect(eventsA.some((e) => e.type === 'shell:output:event')).toBe(true);
      expect(eventsB).toHaveLength(0);

      // Switch emitter
      mgr.setEmitter(emitB);

      // Run another command — events should go to emitter B
      const msg2 = makeMsg('shell:exec:req', { command: 'echo beta', cwd: tmpDir });
      await mgr.handleExec(msg2);

      const bOutputs = eventsB.filter((e) => e.type === 'shell:output:event');
      expect(bOutputs.length).toBeGreaterThan(0);
      expect(bOutputs.some((e) => (e.payload.data as string).includes('beta'))).toBe(true);

      mgr.destroyAll();
    });

    it('preserves tracked processes across emitter swap', async () => {
      const mgr = new ShellManager(emit);

      // Start a long-running process (don't await)
      mgr.handleExec(makeMsg('shell:exec:req', { command: 'sleep 30', cwd: tmpDir }));

      // Give spawn a moment
      await new Promise((r) => setTimeout(r, 50));
      expect(mgr.size).toBeGreaterThan(0);

      // Swap emitter — processes should still be tracked
      const newEvents: WSEvent[] = [];
      mgr.setEmitter((e) => newEvents.push(e));
      expect(mgr.size).toBeGreaterThan(0);

      mgr.destroyAll();
    });
  });

  describe('patchViteConfig (base replacement)', () => {
    it('replaces existing base: value when running dev server command', async () => {
      // Write a vite.config.ts with a stale base path from a "previous session"
      const viteConfig = `import { defineConfig } from 'vite';\nexport default defineConfig({ base: '/sandbox-preview/old-session-id/', server: { host: '0.0.0.0', allowedHosts: true } });\n`;
      await fs.writeFile(path.join(tmpDir, 'vite.config.ts'), viteConfig);

      // Set PREVIEW_BASE_PATH to a new session
      const newBase = '/sandbox-preview/new-session-id/';
      process.env.PREVIEW_BASE_PATH = newBase;

      // Run a dev server command — patchViteConfig runs before spawn
      // Use a fast-exiting command wrapped with the dev server keyword
      const msg = makeMsg('shell:exec:req', { command: 'echo patched && npm run dev', cwd: tmpDir });
      // The command will fail (no package.json) but patchViteConfig runs first
      await manager.handleExec(msg).catch(() => {});

      const result = await fs.readFile(path.join(tmpDir, 'vite.config.ts'), 'utf-8');
      expect(result).toContain(`base: '${newBase}'`);
      expect(result).not.toContain('old-session-id');

      delete process.env.PREVIEW_BASE_PATH;
    });

    it('injects base: when not present in vite config', async () => {
      const viteConfig = `import { defineConfig } from 'vite';\nexport default defineConfig({ server: { host: '0.0.0.0' } });\n`;
      await fs.writeFile(path.join(tmpDir, 'vite.config.ts'), viteConfig);

      const newBase = '/sandbox-preview/test-session/';
      process.env.PREVIEW_BASE_PATH = newBase;

      const msg = makeMsg('shell:exec:req', { command: 'npm run dev', cwd: tmpDir });
      await manager.handleExec(msg).catch(() => {});

      const result = await fs.readFile(path.join(tmpDir, 'vite.config.ts'), 'utf-8');
      expect(result).toContain(`base: '${newBase}'`);

      delete process.env.PREVIEW_BASE_PATH;
    });
  });

  describe('destroyAll', () => {
    it('clears all tracked processes', () => {
      // Start a long-running process but don't await it
      manager.handleExec(makeMsg('shell:exec:req', { command: 'sleep 60', cwd: tmpDir }));

      // Give spawn a moment to start
      // destroyAll should handle whatever state it's in
      manager.destroyAll();
      expect(manager.size).toBe(0);
    });
  });
});

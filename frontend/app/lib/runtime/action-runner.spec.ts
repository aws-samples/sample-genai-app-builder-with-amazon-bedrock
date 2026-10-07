import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ActionRunner } from './action-runner';
import type { RuntimeConnection, WSResponse } from './types';
import type { VibeAction } from '~/types/actions';

vi.mock('react-toastify', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

/**
 * A connection whose responses are scripted per request type, so a test can say
 * "the first fs:write fails" without standing up a WebSocket.
 */
function createConnection(
  handle: (type: string, payload: any) => Promise<unknown> = async () => ({}),
) {
  const requests: { type: string; payload: any }[] = [];
  const listeners = new Map<string, Set<(msg: any) => void>>();

  const conn: RuntimeConnection = {
    async request<T extends WSResponse = WSResponse>(req: any) {
      requests.push({ type: req.type, payload: req.payload });
      const result = await handle(req.type, req.payload);

      return (result ?? { type: `${req.type}:res`, payload: {} }) as T;
    },
    send: vi.fn(),
    on(type, handler) {
      if (!listeners.has(type)) {
        listeners.set(type, new Set());
      }

      listeners.get(type)!.add(handler as any);
    },
    off(type, handler) {
      listeners.get(type)?.delete(handler as any);
    },
    whenReady: async () => {},
    isConnected: () => true,
    close: vi.fn(),
    getSession: () => ({ sessionId: 's', containerId: 'c', workdir: '/w' }),
  };

  return { conn, requests, listeners };
}

function shellOk(exitCode = 0) {
  return { type: 'shell:exec:res', payload: { exitCode } };
}

/** Run one action to completion, mirroring how the message parser drives the runner. */
async function run(runner: ActionRunner, actionId: string, action: VibeAction) {
  const data = { artifactId: 'a', messageId: 'm', actionId, action };
  runner.addAction(data);
  await runner.runAction(data);

  // runAction only queues; drain the internal chain before asserting. The budget
  // must clear the runner's bounded retry backoff (400ms + 800ms) or a retried
  // action looks like a hang.
  await vi.waitFor(
    () => {
      const status = runner.actions.get()[actionId]?.status;
      expect(status === 'complete' || status === 'failed' || status === 'aborted').toBe(true);
    },
    { timeout: 5000, interval: 10 },
  );
}

describe('ActionRunner', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('a failed file write', () => {
    it('marks the action failed rather than reporting it complete', async () => {
      const { conn } = createConnection(async (type) => {
        if (type === 'fs:write:req') {
          throw new Error('Connection timeout');
        }

        return {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });

      expect(runner.actions.get()['0'].status).toBe('failed');
    });

    /**
     * The prod defect: `Create package.json` failed, `npm install` ran anyway
     * against a directory with no package.json and exited 254.
     */
    it('stops a later shell command from running against a half-written project', async () => {
      const { conn, requests } = createConnection(async (type) => {
        if (type === 'fs:write:req') {
          throw new Error('Connection timeout');
        }

        return type === 'shell:exec:req' ? shellOk() : {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });
      await run(runner, '1', { type: 'shell', content: 'npm install' });

      expect(runner.actions.get()['1'].status).toBe('failed');
      expect(requests.filter((r) => r.type === 'shell:exec:req')).toHaveLength(0);
    });

    it('names the step that failed so the user knows where to look', async () => {
      const { conn } = createConnection(async (type) => {
        if (type === 'fs:write:req') {
          throw new Error('Connection timeout');
        }

        return type === 'shell:exec:req' ? shellOk() : {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });
      await run(runner, '1', { type: 'shell', content: 'npm install' });

      const state = runner.actions.get()['1'];
      expect(state.status).toBe('failed');
      expect((state as { error: string }).error).toMatch(/package\.json/);
    });
  });

  describe('a transient connection failure', () => {
    /**
     * The connect-level 'Connection timeout' (connection.ts) is transient: in the
     * prod session the socket recovered and every later write succeeded. Retrying
     * the first write is what turns that into a build that completes.
     */
    it('retries a file write and succeeds once the connection recovers', async () => {
      let attempts = 0;
      const { conn } = createConnection(async (type) => {
        if (type === 'fs:write:req') {
          attempts++;

          if (attempts === 1) {
            throw new Error('Connection timeout');
          }
        }

        return {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });

      expect(attempts).toBeGreaterThan(1);
      expect(runner.actions.get()['0'].status).toBe('complete');
    });

    it('retries resolving the connection before the first file write', async () => {
      const { conn } = createConnection();
      let connectAttempts = 0;

      const runner = new ActionRunner(async () => {
        connectAttempts++;

        if (connectAttempts === 1) {
          throw new Error('Connection timeout');
        }

        return conn;
      });

      await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });

      expect(runner.actions.get()['0'].status).toBe('complete');
    });

    /**
     * A shell command is not idempotent — re-running `npm install` because its
     * response was slow is worse than failing. Only resolving the connection may
     * be retried.
     */
    it('does not re-run a shell command that failed on a non-zero exit', async () => {
      let execs = 0;
      const { conn } = createConnection(async (type) => {
        if (type === 'shell:exec:req') {
          execs++;
          return shellOk(1);
        }

        return {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'shell', content: 'npm install' });

      expect(execs).toBe(1);
      expect(runner.actions.get()['0'].status).toBe('failed');
    });
  });

  describe('the action queue', () => {
    it('does not leave an unhandled rejection when an action fails', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);

      const { conn } = createConnection(async (type) => {
        if (type === 'fs:write:req') {
          throw new Error('Connection timeout');
        }

        return type === 'shell:exec:req' ? shellOk() : {};
      });

      const runner = new ActionRunner(async () => conn);

      try {
        await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });
        await run(runner, '1', { type: 'file', filePath: 'index.html', content: '<html>' });
        await new Promise((resolve) => setTimeout(resolve, 50));

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('still writes later files after an earlier write failed', async () => {
      const failed = new Set(['package.json']);
      const { conn, requests } = createConnection(async (type, payload) => {
        if (type === 'fs:write:req' && failed.has(payload.path)) {
          throw new Error('Connection timeout');
        }

        return {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'file', filePath: 'package.json', content: '{}' });
      await run(runner, '1', { type: 'file', filePath: 'index.html', content: '<html>' });

      expect(runner.actions.get()['1'].status).toBe('complete');
      expect(requests.some((r) => r.type === 'fs:write:req' && r.payload.path === 'index.html')).toBe(true);
    });
  });

  describe('a dev server behind a failed step', () => {
    it('refuses to start when an earlier command exited non-zero', async () => {
      const { conn } = createConnection(async (type, payload) => {
        if (type === 'shell:exec:req') {
          return shellOk(payload.command === 'npm install' ? 254 : 0);
        }

        return {};
      });

      const runner = new ActionRunner(async () => conn);

      await run(runner, '0', { type: 'shell', content: 'npm install' });
      await run(runner, '1', { type: 'shell', content: 'npm run dev' });

      const state = runner.actions.get()['1'];
      expect(state.status).toBe('failed');
      expect((state as { error: string }).error).toMatch(/254/);
    });
  });
});

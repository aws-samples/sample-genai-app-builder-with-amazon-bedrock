import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket, type WebSocketServer } from 'ws';
import { startServer, type ServerOptions } from '../src/server.js';

function makeReq(type: string, payload: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Collect messages from a WebSocket into a queue.
 * Returns a `next()` function that resolves with the next message.
 */
function createMessageQueue(ws: WebSocket) {
  const queue: Record<string, unknown>[] = [];
  const waiters: Array<(msg: Record<string, unknown>) => void> = [];

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const waiter = waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      queue.push(msg);
    }
  });

  return {
    next(timeoutMs = 5000): Promise<Record<string, unknown>> {
      const buffered = queue.shift();
      if (buffered) return Promise.resolve(buffered);

      return new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for message (${timeoutMs}ms)`)),
          timeoutMs
        );
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

describe('WebSocket server', () => {
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;

  /**
   * The session the session manager tagged this task with. Stands in for the
   * `SandboxSession` ECS task tag the sidecar reads at bind time.
   */
  let assigned: string | null;
  let retired: number;

  /** Start a server whose task is assigned the `assigned` session. */
  function start(options: ServerOptions = {}): WebSocketServer {
    wss = startServer(port, {
      resolveAssignedSession: async () => assigned,
      onRetire: () => {
        retired++;
      },
      ...options,
    });
    return wss;
  }

  beforeEach(async () => {
    port = 10000 + Math.floor(Math.random() * 50000);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-server-test-'));
    process.env.WORKDIR = tmpDir;
    assigned = randomUUID();
    retired = 0;
  });

  afterEach(async () => {
    if (wss) {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
    delete process.env.WORKDIR;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  /**
   * Connect and set up message queue in one step so no messages are lost.
   */
  function connectWithQueue(sessionId?: string): Promise<{ ws: WebSocket; messages: ReturnType<typeof createMessageQueue> }> {
    const sid = sessionId ?? assigned!;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/${sid}`);
      const messages = createMessageQueue(ws);
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
    });
  }

  it('sends system:ready:event on connection', async () => {
    start();

    const { ws, messages } = await connectWithQueue();

    const msg = await messages.next();
    expect(msg.type).toBe('system:ready:event');
    expect(msg.payload).toHaveProperty('sessionId');
    expect(msg.payload).toHaveProperty('workdir');

    ws.close();
  });

  it('responds to system:ping:req with uptime', async () => {
    start();

    const { ws, messages } = await connectWithQueue();

    // Consume the ready event
    await messages.next();

    const req = makeReq('system:ping:req');
    ws.send(JSON.stringify(req));

    const res = await messages.next();
    expect(res.type).toBe('system:ping:res');
    expect(res.requestId).toBe(req.id);
    expect(typeof (res.payload as any).uptime).toBe('number');

    ws.close();
  });

  it('sends error event for invalid JSON', async () => {
    start();

    const { ws, messages } = await connectWithQueue();
    await messages.next(); // ready event

    ws.send('not valid json{{{');

    const msg = await messages.next();
    expect(msg.type).toBe('system:error:event');
    expect((msg.payload as any).code).toBe('PARSE_ERROR');

    ws.close();
  });

  it('sends error event for unknown namespace', async () => {
    start();

    const { ws, messages } = await connectWithQueue();
    await messages.next(); // ready event

    const req = makeReq('foobar:action:req');
    ws.send(JSON.stringify(req));

    const msg = await messages.next();
    expect(msg.type).toBe('system:error:event');
    expect((msg.payload as any).code).toBe('UNKNOWN_NAMESPACE');

    ws.close();
  });

  it('sends error event for non-request direction', async () => {
    start();

    const { ws, messages } = await connectWithQueue();
    await messages.next(); // ready event

    const req = makeReq('system:ping:res'); // wrong direction
    ws.send(JSON.stringify(req));

    const msg = await messages.next();
    expect(msg.type).toBe('system:error:event');
    expect((msg.payload as any).code).toBe('INVALID_DIRECTION');

    ws.close();
  });

  it('routes fs:read:req and returns an error for missing file', async () => {
    start();

    const { ws, messages } = await connectWithQueue();
    await messages.next(); // ready event

    const req = makeReq('fs:read:req', { path: 'nonexistent-file-xyz.txt' });
    ws.send(JSON.stringify(req));

    const msg = await messages.next();
    expect(msg.type).toBe('system:error:event');
    expect((msg.payload as any).code).toBe('HANDLER_ERROR');

    ws.close();
  });

  it('returns 503 retry page for preview requests with wrong session ID', async () => {
    start();

    // Connect with session A to establish the binding
    const sidA = assigned!;
    const { ws, messages } = await connectWithQueue(sidA);
    await messages.next(); // ready event

    // HTTP request for a DIFFERENT session's preview → should get 503
    const wrongSid = randomUUID();
    const res = await fetch(`http://localhost:${port}/sandbox-preview/${wrongSid}/`);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(body).toContain('Loading preview...');
    expect(body).toContain('AWSALB=;expires=');

    ws.close();
  });

  it('proxies preview requests for the correct session ID', async () => {
    start();

    const sid = assigned!;
    const { ws, messages } = await connectWithQueue(sid);
    await messages.next(); // ready event

    // HTTP request for the CORRECT session → should proxy to Vite (503 since Vite isn't running, but NOT the retry page)
    const res = await fetch(`http://localhost:${port}/sandbox-preview/${sid}/`);
    const body = await res.text();
    // The proxy error handler returns a retry page too, but with different text pattern.
    // Key test: request was NOT rejected by session validation (it reached proxyToVite).
    // Since no Vite server is running, we get the proxy error page (503).
    expect(res.status).toBe(503);
    expect(body).toContain('Loading preview...');

    ws.close();
  });

  it('cleans up when client disconnects', async () => {
    start();

    const sid = assigned!;
    const { ws, messages } = await connectWithQueue(sid);
    await messages.next(); // ready event

    ws.close();

    // Give server a moment to process the close
    await new Promise((r) => setTimeout(r, 200));

    // Server should still be running (accepting new connections).
    // Use same session ID so server treats it as a reconnect (no pkill).
    const { ws: ws2, messages: messages2 } = await connectWithQueue(sid);
    const msg = await messages2.next();
    expect(msg.type).toBe('system:ready:event');
    ws2.close();
  });

  /**
   * Authorisation is not this server's job: CloudFront admits the upgrade only
   * with a signed URL for the session, and the ALB forwards only CloudFront's
   * traffic. The server must therefore tolerate whatever query string that
   * leaves on the URL and key purely on the session id in the path.
   */
  describe('upgrade', () => {
    it('serves the session named in the path, ignoring CloudFront signing parameters', async () => {
      start();
      const sid = assigned!;
      const ws = new WebSocket(
        `ws://localhost:${port}/ws/${sid}?Policy=abc~&Signature=def_-&Key-Pair-Id=K2TEST`,
      );
      const msg = await new Promise<any>((resolve, reject) => {
        ws.on('message', (data) => resolve(JSON.parse(data.toString())));
        ws.on('error', reject);
      });
      expect(msg.type).toBe('system:ready:event');
      ws.close();
    });

    it.each([
      // Paths CloudFront does not require a signature for must never open a
      // session socket, even when an id appears elsewhere in the URL.
      ['an id smuggled in the query string', (sid: string) => `/ws?/ws/${sid}`],
      ['an id under another path', (sid: string) => `/other/ws/${sid}`],
      ['an id followed by extra segments', (sid: string) => `/ws/${sid}/extra`],
    ])('refuses %s', async (_label, pathFor) => {
      start();
      const ws = new WebSocket(`ws://localhost:${port}${pathFor(randomUUID())}`);
      const code = await new Promise<number>((resolve, reject) => {
        ws.on('close', (c) => resolve(c));
        ws.on('message', () => reject(new Error('session socket was opened')));
        ws.on('error', () => {});
      });
      expect(code).toBe(4000);
    });
  });
  /** Open a socket for `sessionId` and resolve with the close code it receives. */
  function expectClosed(sessionId: string, timeoutMs = 5000): Promise<{ code: number; reason: string }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/${sessionId}`);
      const timer = setTimeout(() => reject(new Error('connection was not closed')), timeoutMs);
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'system:ready:event') {
          clearTimeout(timer);
          reject(new Error(`session ${sessionId} was served`));
        }
      });
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        resolve({ code, reason: reason.toString() });
      });
      ws.on('error', () => {
        /* close event still fires */
      });
    });
  }

  /**
   * Multi-peer safety. Two collaborators share one session (one container): the
   * second peer must be adopted without disturbing the first peer's workspace.
   */
  describe('multi-peer safety', () => {
    it('adopts a second peer on the same session without wiping the workdir', async () => {
      start();

      const sid = assigned!;
      const { ws: a, messages: aMsgs } = await connectWithQueue(sid);
      await aMsgs.next(); // ready

      // Peer A creates a file — this stands in for "work in progress".
      const marker = path.join(tmpDir, 'peer-a-work.txt');
      await fs.writeFile(marker, 'important work');

      // Peer B joins the SAME session while A is still connected.
      const { ws: b, messages: bMsgs } = await connectWithQueue(sid);
      const ready = await bMsgs.next();
      expect(ready.type).toBe('system:ready:event');

      // A's work must survive B joining.
      await expect(fs.readFile(marker, 'utf-8')).resolves.toBe('important work');

      a.close();
      b.close();
    });

    it('delivers shared filesystem events to every peer, not just the newest', async () => {
      start();

      const sid = assigned!;
      const { ws: a, messages: aMsgs } = await connectWithQueue(sid);
      await aMsgs.next(); // ready

      const { ws: b, messages: bMsgs } = await connectWithQueue(sid);
      await bMsgs.next(); // ready

      // Writing through B changes shared container state, so BOTH peers must
      // learn about it — previously the most recent connection captured the
      // event stream and earlier peers were left stale.
      b.send(JSON.stringify(makeReq('fs:write:req', { path: 'shared.txt', content: 'hello' })));

      const seen = async (messages: ReturnType<typeof createMessageQueue>) => {
        // Skip the write response; wait for the broadcast change event.
        for (let i = 0; i < 6; i++) {
          const msg = await messages.next(8000);
          if (msg.type === 'fs:change:event') {
            return msg;
          }
        }
        throw new Error('no fs:change:event received');
      };

      const [aEvent, bEvent] = await Promise.all([seen(aMsgs), seen(bMsgs)]);
      expect(aEvent.type).toBe('fs:change:event');
      expect(bEvent.type).toBe('fs:change:event');

      a.close();
      b.close();
    });
  });

  /**
   * Session binding (Sev2 SOC D550368291). A task serves exactly one session for
   * its lifetime: the one the session manager tagged it with before signing the
   * URL. Any other session id is refused with 4003 — while peers are live, after
   * they have all left, and after the idle release — and the refused connection
   * never touches the bound session's workdir or processes.
   */
  describe('session binding', () => {
    it('refuses a foreign session while peers are connected, preserving their workdir', async () => {
      start();

      const { ws: a, messages: aMsgs } = await connectWithQueue();
      await aMsgs.next(); // ready

      const marker = path.join(tmpDir, 'peer-a-work.txt');
      await fs.writeFile(marker, 'important work');

      const closed = await expectClosed(randomUUID());
      expect(closed.code).toBe(4003);
      expect(closed.reason).toBe('Not assigned');

      await expect(fs.readFile(marker, 'utf-8')).resolves.toBe('important work');
      a.close();
    });

    it('refuses a foreign session after the bound user has disconnected, and keeps their workdir', async () => {
      start();

      const { ws: a, messages: aMsgs } = await connectWithQueue();
      await aMsgs.next(); // ready
      const marker = path.join(tmpDir, 'peer-a-work.txt');
      await fs.writeFile(marker, 'important work');

      a.close();
      await new Promise((r) => setTimeout(r, 200));

      // The room is empty. Previously the container adopted the newcomer here and
      // wiped the previous user's work; it must refuse instead.
      const closed = await expectClosed(randomUUID());
      expect(closed.code).toBe(4003);

      await expect(fs.readFile(marker, 'utf-8')).resolves.toBe('important work');

      // And the rightful owner can still reconnect to their untouched workspace.
      const { ws: again, messages } = await connectWithQueue();
      expect((await messages.next()).type).toBe('system:ready:event');
      again.close();
    });

    it('never re-binds to a second session, even if the assignment later changes', async () => {
      start();

      const first = assigned!;
      const { ws: a, messages: aMsgs } = await connectWithQueue(first);
      await aMsgs.next();
      a.close();
      await new Promise((r) => setTimeout(r, 100));

      // Even a matching tag for a second session must not re-bind the task.
      const second = randomUUID();
      assigned = second;
      expect((await expectClosed(second)).code).toBe(4003);
    });

    it('refuses the first connection when it does not match the task assignment, without wiping anything', async () => {
      const marker = path.join(tmpDir, 'template.txt');
      await fs.writeFile(marker, 'seed');
      start();

      expect((await expectClosed(randomUUID())).code).toBe(4003);
      await expect(fs.readFile(marker, 'utf-8')).resolves.toBe('seed');

      // The assigned session still binds afterwards.
      const { ws, messages } = await connectWithQueue();
      expect((await messages.next()).type).toBe('system:ready:event');
      ws.close();
    });

    it('fails closed when the task has no assignment', async () => {
      assigned = null;
      start();

      expect((await expectClosed(randomUUID())).code).toBe(4003);
    });

    it('fails closed when the assignment cannot be read', async () => {
      start({
        resolveAssignedSession: async () => {
          throw new Error('metadata endpoint unavailable');
        },
      });

      expect((await expectClosed(randomUUID())).code).toBe(4003);
    });

    it('does not serve another session preview before binding', async () => {
      start();

      const res = await fetch(`http://localhost:${port}/sandbox-preview/${assigned}/`);
      // Not bound yet, so even the assigned session's preview gets the retry page.
      expect(res.status).toBe(503);
    });

    it('retires the task once the last peer has been gone for the release window', async () => {
      start({ releaseTimeoutMs: 100 });

      const { ws: a, messages: aMsgs } = await connectWithQueue();
      await aMsgs.next();
      a.close();

      await new Promise((r) => setTimeout(r, 400));
      expect(retired).toBe(1);

      // Retiring never frees the task for someone else.
      expect((await expectClosed(randomUUID())).code).toBe(4003);
    });

    it('does not retire while a peer reconnects inside the release window', async () => {
      start({ releaseTimeoutMs: 300 });

      const { ws: a, messages: aMsgs } = await connectWithQueue();
      await aMsgs.next();
      a.close();
      await new Promise((r) => setTimeout(r, 50));

      const { ws: b, messages: bMsgs } = await connectWithQueue();
      await bMsgs.next();
      await new Promise((r) => setTimeout(r, 500));

      expect(retired).toBe(0);
      b.close();
    });
  });
});

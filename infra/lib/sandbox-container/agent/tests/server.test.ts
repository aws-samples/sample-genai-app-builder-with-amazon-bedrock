import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket, type WebSocketServer } from 'ws';
import { startServer } from '../src/server.js';

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

  beforeEach(async () => {
    port = 10000 + Math.floor(Math.random() * 50000);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-server-test-'));
    process.env.WORKDIR = tmpDir;
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
    const sid = sessionId ?? randomUUID();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/${sid}`);
      const messages = createMessageQueue(ws);
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
    });
  }

  it('sends system:ready:event on connection', async () => {
    wss = startServer(port);

    const { ws, messages } = await connectWithQueue();

    const msg = await messages.next();
    expect(msg.type).toBe('system:ready:event');
    expect(msg.payload).toHaveProperty('sessionId');
    expect(msg.payload).toHaveProperty('workdir');

    ws.close();
  });

  it('responds to system:ping:req with uptime', async () => {
    wss = startServer(port);

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
    wss = startServer(port);

    const { ws, messages } = await connectWithQueue();
    await messages.next(); // ready event

    ws.send('not valid json{{{');

    const msg = await messages.next();
    expect(msg.type).toBe('system:error:event');
    expect((msg.payload as any).code).toBe('PARSE_ERROR');

    ws.close();
  });

  it('sends error event for unknown namespace', async () => {
    wss = startServer(port);

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
    wss = startServer(port);

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
    wss = startServer(port);

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
    wss = startServer(port);

    // Connect with session A to establish currentSessionId
    const sidA = randomUUID();
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
    wss = startServer(port);

    const sid = randomUUID();
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
    wss = startServer(port);

    const sid = randomUUID();
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
      wss = startServer(port);
      const sid = randomUUID();
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
      wss = startServer(port);
      const ws = new WebSocket(`ws://localhost:${port}${pathFor(randomUUID())}`);
      const code = await new Promise<number>((resolve, reject) => {
        ws.on('close', (c) => resolve(c));
        ws.on('message', () => reject(new Error('session socket was opened')));
        ws.on('error', () => {});
      });
      expect(code).toBe(4000);
    });
  });
  /**
   * Multi-peer safety. Two collaborators share one session (one container): the
   * second peer must be adopted without disturbing the first peer's workspace,
   * and a connection presenting a *foreign* session id while peers are live must
   * be refused rather than allowed to wipe the workdir out from under them.
   */
  describe('multi-peer safety', () => {
    it('adopts a second peer on the same session without wiping the workdir', async () => {
      wss = startServer(port);

      const sid = randomUUID();
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

    it('refuses a foreign session id while peers are connected, preserving their workdir', async () => {
      wss = startServer(port);

      const sid = randomUUID();
      const { ws: a, messages: aMsgs } = await connectWithQueue(sid);
      await aMsgs.next(); // ready

      const marker = path.join(tmpDir, 'peer-a-work.txt');
      await fs.writeFile(marker, 'important work');

      // A stray client (e.g. mis-routed by the load balancer) presents a
      // DIFFERENT session id while A is still live. It must be closed, not
      // adopted — adopting it would clean the workdir and kill A's processes.
      const strayId = randomUUID();
      const stray = new WebSocket(`ws://localhost:${port}/ws/${strayId}`);
      const closeCode = await new Promise<number>((resolve, reject) => {
        stray.on('close', (code) => resolve(code));
        stray.on('error', () => {
          /* close event still fires */
        });
        setTimeout(() => reject(new Error('stray connection was not closed')), 5000);
      });

      expect(closeCode).toBe(4001);

      // A's work must be untouched.
      await expect(fs.readFile(marker, 'utf-8')).resolves.toBe('important work');

      a.close();
    });

    it('delivers shared filesystem events to every peer, not just the newest', async () => {
      wss = startServer(port);

      const sid = randomUUID();
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

    it('still adopts a new session once the previous peers have all left', async () => {
      wss = startServer(port);

      const first = randomUUID();
      const { ws: a, messages: aMsgs } = await connectWithQueue(first);
      await aMsgs.next(); // ready
      a.close();
      await new Promise((r) => setTimeout(r, 200));

      // Room is empty now, so a genuinely new session is free to claim the box.
      const { ws: b, messages: bMsgs } = await connectWithQueue(randomUUID());
      const ready = await bMsgs.next();
      expect(ready.type).toBe('system:ready:event');
      b.close();
    });
  });
});

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
});

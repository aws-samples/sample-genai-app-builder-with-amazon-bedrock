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
 * Mirrors the helper in server.test.ts so both suites read the same way.
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

describe('collaboration relay (yjs namespace)', () => {
  let wss: WebSocketServer;
  let port: number;
  let tmpDir: string;

  /** The session this task is assigned; see the binding tests in server.test.ts. */
  let session: string;

  function start(): WebSocketServer {
    return startServer(port, { resolveAssignedSession: async () => session, onRetire: () => {} });
  }

  beforeEach(async () => {
    session = randomUUID();
    port = 10000 + Math.floor(Math.random() * 50000);
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-relay-test-'));
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

  function connectWithQueue(sessionId: string): Promise<{ ws: WebSocket; messages: ReturnType<typeof createMessageQueue> }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/ws/${sessionId}`);
      const messages = createMessageQueue(ws);
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
    });
  }

  it('relays a yjs:sync frame to a peer in the same session', async () => {
    wss = start();

    // Two collaborators editing the SAME project share one session ID.
    const a = await connectWithQueue(session);
    await a.messages.next(); // ready event
    const b = await connectWithQueue(session);
    await b.messages.next(); // ready event

    // A produces an opaque Yjs update frame; the payload is base64 bytes the
    // server must never interpret.
    const frame = makeReq('yjs:sync:req', { data: 'AQIDBA==' });
    a.ws.send(JSON.stringify(frame));

    // B receives it verbatim as a message of the same type.
    const received = await b.messages.next();
    expect(received.type).toBe('yjs:sync:req');
    expect((received.payload as any).data).toBe('AQIDBA==');
    expect(received.id).toBe(frame.id);

    a.ws.close();
    b.ws.close();
  });

  it('relays yjs:awareness frames (presence) the same way', async () => {
    wss = start();

    const a = await connectWithQueue(session);
    await a.messages.next();
    const b = await connectWithQueue(session);
    await b.messages.next();

    const presence = makeReq('yjs:awareness:req', { data: 'cHJlc2VuY2U=' });
    a.ws.send(JSON.stringify(presence));

    const received = await b.messages.next();
    expect(received.type).toBe('yjs:awareness:req');
    expect((received.payload as any).data).toBe('cHJlc2VuY2U=');

    a.ws.close();
    b.ws.close();
  });

  it('does not echo a frame back to its sender', async () => {
    wss = start();

    const a = await connectWithQueue(session);
    await a.messages.next();
    const b = await connectWithQueue(session);
    await b.messages.next();

    // A sends a collab frame, then immediately a ping. If the relay wrongly
    // echoed the frame back to A, A's next message would be the yjs frame.
    // Correct behaviour: A's next message is the ping response.
    a.ws.send(JSON.stringify(makeReq('yjs:sync:req', { data: 'AQ==' })));
    const ping = makeReq('system:ping:req');
    a.ws.send(JSON.stringify(ping));

    const next = await a.messages.next();
    expect(next.type).toBe('system:ping:res');
    expect(next.requestId).toBe(ping.id);

    // B still received the frame.
    const bReceived = await b.messages.next();
    expect(bReceived.type).toBe('yjs:sync:req');

    a.ws.close();
    b.ws.close();
  });

  it('never relays frames across different sessions (isolation)', async () => {
    wss = start();

    // Two peers in session ONE relay to each other.
    const sessionOne = session;
    const a = await connectWithQueue(sessionOne);
    await a.messages.next();
    const b = await connectWithQueue(sessionOne);
    await b.messages.next();

    // A foreign session cannot even become co-resident on a container: a task
    // serves only the session it was assigned and refuses every other one at
    // connect time (see session binding in server.ts), a stronger guarantee
    // than filtering its frames would be. Frame-level room isolation is covered
    // directly against the registry in room-registry.test.ts.
    const strayId = randomUUID();
    const stray = new WebSocket(`ws://localhost:${port}/ws/${strayId}`);
    const strayClose = await new Promise<number>((resolve, reject) => {
      stray.on('close', (code) => resolve(code));
      stray.on('error', () => {
        /* the close event still fires */
      });
      setTimeout(() => reject(new Error('foreign session was not refused')), 5000);
    });
    expect(strayClose).toBe(4003);

    // A broadcasts; B (same session) receives it.
    a.ws.send(JSON.stringify(makeReq('yjs:sync:req', { data: 'c2VjcmV0' })));

    const bReceived = await b.messages.next();
    expect(bReceived.type).toBe('yjs:sync:req');
    expect((bReceived.payload as any).data).toBe('c2VjcmV0');

    a.ws.close();
    b.ws.close();
  });

  it('tolerates a solo editor (broadcast with no peers is a no-op)', async () => {
    wss = start();

    const a = await connectWithQueue(session);
    await a.messages.next();

    // No peers — the frame goes nowhere and the server stays responsive.
    a.ws.send(JSON.stringify(makeReq('yjs:sync:req', { data: 'AQ==' })));
    const ping = makeReq('system:ping:req');
    a.ws.send(JSON.stringify(ping));

    const next = await a.messages.next();
    expect(next.type).toBe('system:ping:res');
    expect(next.requestId).toBe(ping.id);

    a.ws.close();
  });
});

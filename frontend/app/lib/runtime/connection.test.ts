import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeConnectionImpl, redactWsUrl } from './connection';
import type { RuntimeConfig } from './types';

// Mock WebSocket
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  url: string;
  onopen: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;

  sent: string[] = [];

  /**
   * When false, new sockets stay CONNECTING. Needed to exhaust the reconnect
   * budget: the real client resets its attempt counter on open.
   */
  static autoOpen = true;

  constructor(url: string) {
    this.url = url;

    if (!MockWebSocket.autoOpen) {
      return;
    }

    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.({});
    }, 0);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: 'Normal closure' });
  }

  // Test helpers
  simulateMessage(data: any) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }

  simulateClose(code = 1006, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  simulateError() {
    this.onerror?.({});
  }
}

// Replace global WebSocket
let mockWsInstance: MockWebSocket;
const originalWebSocket = globalThis.WebSocket;

function installMockWebSocket() {
  MockWebSocket.autoOpen = true;
  (globalThis as any).WebSocket = class extends MockWebSocket {
    constructor(url: string) {
      super(url);
      mockWsInstance = this;
    }
  };

  // Copy static properties
  (globalThis as any).WebSocket.OPEN = MockWebSocket.OPEN;
  (globalThis as any).WebSocket.CLOSED = MockWebSocket.CLOSED;
  (globalThis as any).WebSocket.CONNECTING = MockWebSocket.CONNECTING;
  (globalThis as any).WebSocket.CLOSING = MockWebSocket.CLOSING;
}

function restoreWebSocket() {
  globalThis.WebSocket = originalWebSocket;
}

const defaultConfig: RuntimeConfig = {
  wsEndpoint: 'ws://localhost:8080',
  reconnect: false,
  requestTimeout: 5000,
  pingInterval: 60000,
};

function sendReadyEvent() {
  mockWsInstance.simulateMessage({
    id: crypto.randomUUID(),
    type: 'system:ready:event',
    timestamp: Date.now(),
    payload: {
      sessionId: 'test-session',
      containerId: 'test-container',
      workdir: '/home/sandbox/project',
    },
  });
}

describe('RuntimeConnectionImpl', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    installMockWebSocket();
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreWebSocket();
  });

  describe('connect()', () => {
    it('should connect and resolve when system:ready is received', async () => {
      const conn = new RuntimeConnectionImpl(defaultConfig);
      const connectPromise = conn.connect();

      // Wait for WebSocket to "open"
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();

      await connectPromise;
      expect(conn.isConnected()).toBe(true);
      conn.close();
    });

    it('should populate session info from ready event', async () => {
      const conn = new RuntimeConnectionImpl(defaultConfig);
      const connectPromise = conn.connect();

      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await connectPromise;

      const session = conn.getSession();
      expect(session.sessionId).toBe('test-session');
      expect(session.containerId).toBe('test-container');
      expect(session.workdir).toBe('/home/sandbox/project');
      conn.close();
    });

    it('dials the signed endpoint exactly as issued, adding no user credential', async () => {
      // The signature is what CloudFront checks, and a bearer token in the URL
      // would land in CloudFront and ALB access logs.
      const endpoint = 'ws://localhost:8080/ws/sess-1?Policy=abc&Signature=def&Key-Pair-Id=K2';
      const conn = new RuntimeConnectionImpl({ ...defaultConfig, wsEndpoint: endpoint });
      const connectPromise = conn.connect();

      await vi.advanceTimersByTimeAsync(10);
      expect(mockWsInstance.url).toBe(endpoint);

      sendReadyEvent();
      await connectPromise;
      conn.close();
    });

    it('should reject on connection timeout', async () => {
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        requestTimeout: 100,
        reconnect: false,
      });
      const connectPromise = conn.connect().catch((e: Error) => e);

      // Don't send ready event — let it timeout
      await vi.advanceTimersByTimeAsync(200);

      const result = await connectPromise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Connection timeout');
    });
  });

  describe('request()', () => {
    let conn: RuntimeConnectionImpl;

    beforeEach(async () => {
      conn = new RuntimeConnectionImpl(defaultConfig);
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;
    });

    afterEach(() => {
      conn.close();
    });

    it('should send a request and resolve with matching response', async () => {
      const requestPromise = conn.request({
        type: 'fs:read:req' as any,
        payload: { path: '/src/App.tsx' },
      });

      // Get the sent message to extract the request ID
      const sentMsg = JSON.parse(mockWsInstance.sent[mockWsInstance.sent.length - 1]);
      expect(sentMsg.type).toBe('fs:read:req');
      expect(sentMsg.payload.path).toBe('/src/App.tsx');

      // Simulate response
      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'fs:read:res',
        requestId: sentMsg.id,
        timestamp: Date.now(),
        payload: { content: 'const App = () => <div/>;', isBinary: false, encoding: 'utf8' },
      });

      const response = await requestPromise;
      expect(response.payload).toEqual({
        content: 'const App = () => <div/>;',
        isBinary: false,
        encoding: 'utf8',
      });
    });

    it('should reject with error when response has error field', async () => {
      const requestPromise = conn.request({
        type: 'fs:read:req' as any,
        payload: { path: '/nonexistent' },
      });

      const sentMsg = JSON.parse(mockWsInstance.sent[mockWsInstance.sent.length - 1]);

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'fs:read:res',
        requestId: sentMsg.id,
        timestamp: Date.now(),
        payload: {},
        error: { code: 'FILE_NOT_FOUND', message: 'File not found: /nonexistent' },
      });

      await expect(requestPromise).rejects.toThrow('File not found: /nonexistent');
    });

    it('should reject on timeout', async () => {
      const requestPromise = conn.request({
        type: 'fs:read:req' as any,
        payload: { path: '/slow' },
      }).catch((e: Error) => e);

      // Advance past the request timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await requestPromise;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Request timeout: fs:read:req');
    });

    it('should throw when not connected', async () => {
      conn.close();

      await expect(
        conn.request({ type: 'fs:read:req' as any, payload: {} })
      ).rejects.toThrow('Not connected');
    });
  });

  describe('event handling', () => {
    let conn: RuntimeConnectionImpl;

    beforeEach(async () => {
      conn = new RuntimeConnectionImpl(defaultConfig);
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;
    });

    afterEach(() => {
      conn.close();
    });

    it('should dispatch events to registered handlers', async () => {
      const handler = vi.fn();
      conn.on('fs:change:event', handler);

      const event = {
        id: crypto.randomUUID(),
        type: 'fs:change:event',
        timestamp: Date.now(),
        payload: { eventType: 'add_file', path: '/src/new.ts', content: 'aGVsbG8=' },
      };

      mockWsInstance.simulateMessage(event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('should support multiple handlers for the same event', async () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      conn.on('port:open:event', handler1);
      conn.on('port:open:event', handler2);

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'port:open:event',
        timestamp: Date.now(),
        payload: { port: 5173, url: 'https://test.preview.example.com', protocol: 'https' },
      });

      expect(handler1).toHaveBeenCalledOnce();
      expect(handler2).toHaveBeenCalledOnce();
    });

    it('should unsubscribe handlers with off()', async () => {
      const handler = vi.fn();
      conn.on('terminal:output:event', handler);

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'terminal:output:event',
        timestamp: Date.now(),
        payload: { terminalId: 'term-1', data: 'aGVsbG8=' },
      });

      expect(handler).toHaveBeenCalledOnce();

      conn.off('terminal:output:event', handler);

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'terminal:output:event',
        timestamp: Date.now(),
        payload: { terminalId: 'term-1', data: 'aGVsbG8=' },
      });

      // Should NOT have been called again
      expect(handler).toHaveBeenCalledOnce();
    });

    it('should dispatch to wildcard handlers', async () => {
      const handler = vi.fn();
      conn.on('*', handler);

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'fs:change:event',
        timestamp: Date.now(),
        payload: {},
      });

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'port:open:event',
        timestamp: Date.now(),
        payload: {},
      });

      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe('readiness barrier', () => {
    const reconnectConfig: RuntimeConfig = {
      ...defaultConfig,
      reconnect: true,
      reconnectInterval: 100,
      maxReconnectAttempts: 5,
    };

    async function connectReady(config: RuntimeConfig = reconnectConfig) {
      const conn = new RuntimeConnectionImpl(config);
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;

      return conn;
    }

    it('whenReady() resolves immediately while the socket is open', async () => {
      const conn = await connectReady();

      await expect(conn.whenReady()).resolves.toBeUndefined();

      conn.close();
    });

    it('sends a request issued mid-reconnect once the connection is ready again', async () => {
      // The prod failure this guards: the first write of an artifact landed while
      // the socket was between sockets, rejected with 'Not connected', and the
      // build then ran against an empty directory.
      const conn = await connectReady();

      mockWsInstance.simulateClose(1006, 'Connection lost');
      expect(conn.isConnected()).toBe(false);

      const requestPromise = conn.request({
        type: 'fs:write:req' as any,
        payload: { path: '/package.json', content: '{}' },
      });

      // Nothing may go on the wire while there is no open socket.
      await vi.advanceTimersByTimeAsync(0);
      expect(mockWsInstance.sent).toHaveLength(0);

      // Let the reconnect fire and the new socket come up.
      await vi.advanceTimersByTimeAsync(300);
      sendReadyEvent();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWsInstance.sent).toHaveLength(1);

      const sentMsg = JSON.parse(mockWsInstance.sent[0]);
      expect(sentMsg.type).toBe('fs:write:req');

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'fs:write:res',
        requestId: sentMsg.id,
        timestamp: Date.now(),
        payload: { path: '/package.json' },
      });

      await expect(requestPromise).resolves.toMatchObject({ type: 'fs:write:res' });

      conn.close();
    });

    it('rejects promptly, without waiting out the timeout, once close() has been called', async () => {
      const conn = await connectReady();
      conn.close();

      const result = await conn.request({ type: 'fs:read:req' as any, payload: {} }).catch((e: Error) => e);

      // No timers advanced: the rejection must be immediate, and must say why.
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/closed by the client/i);

      conn.close();
    });

    it('rejects with an exhaustion reason once the reconnect budget is spent', async () => {
      const conn = await connectReady({ ...reconnectConfig, maxReconnectAttempts: 1 });

      // Replacement sockets must not reach open, or the client resets its
      // attempt counter and the budget never runs out.
      MockWebSocket.autoOpen = false;

      // First drop schedules the one and only reconnect attempt.
      mockWsInstance.simulateClose(1006, 'Connection lost');
      await vi.advanceTimersByTimeAsync(300);

      // The replacement socket dies before opening, which spends the budget.
      mockWsInstance.simulateClose(1006, 'Connection lost again');
      await vi.advanceTimersByTimeAsync(300);

      const result = await conn.request({ type: 'fs:read:req' as any, payload: {} }).catch((e: Error) => e);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/exhaust/i);

      conn.close();
    });

    it('keeps the per-request timeout as the outer bound on a readiness wait', async () => {
      // reconnectInterval is longer than the request budget, so readiness never
      // arrives in time. The request must fail on its own timeout, not hang.
      const conn = await connectReady({ ...reconnectConfig, reconnectInterval: 60000 });

      mockWsInstance.simulateClose(1006, 'Connection lost');

      const req = { type: 'fs:read:req' as any, payload: { path: '/slow' } };
      const pending = conn.request(req, 200).catch((e: Error) => e);

      await vi.advanceTimersByTimeAsync(500);

      const result = await pending;
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Request timeout: fs:read:req');

      conn.close();
    });

    it('still drops send() frames while offline rather than queueing them', async () => {
      // Yjs resynchronises from scratch on reconnect, so a replayed update is at
      // best redundant. send() must stay fire-and-forget.
      const conn = await connectReady();

      mockWsInstance.simulateClose(1006, 'Connection lost');

      conn.send({ type: 'yjs:update:req' as any, payload: { update: 'abc' } });

      await vi.advanceTimersByTimeAsync(300);
      sendReadyEvent();
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWsInstance.sent).toHaveLength(0);

      conn.close();
    });
  });

  describe('liveness probe', () => {
    // A half-open socket — TCP path dead, no FIN, so onclose never fires — still
    // reads OPEN. Nothing else in the client notices: the readiness barrier takes
    // its fast path while isConnected() is true, and requests sit on the 120s
    // request timeout rather than failing as connection errors. The ping is the
    // only thing that can tell, so a failed ping has to mean something.
    const liveConfig: RuntimeConfig = {
      ...defaultConfig,
      reconnect: true,
      reconnectInterval: 100,
      maxReconnectAttempts: 5,
      requestTimeout: 60000,
      pingInterval: 1000,
      pingTimeout: 200,
    };

    async function connectReady(config: RuntimeConfig = liveConfig) {
      const conn = new RuntimeConnectionImpl(config);
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;

      return conn;
    }

    /** Answer the most recent ping, i.e. behave like a live sidecar. */
    function pong() {
      const pings = mockWsInstance.sent.map((s) => JSON.parse(s)).filter((m) => m.type === 'system:ping:req');
      expect(pings.length).toBeGreaterThan(0);

      mockWsInstance.simulateMessage({
        id: crypto.randomUUID(),
        type: 'system:ping:res',
        requestId: pings[pings.length - 1].id,
        timestamp: Date.now(),
        payload: {},
      });
    }

    it('force-closes and reconnects a half-open socket whose pings go unanswered', async () => {
      const conn = await connectReady();
      const deadSocket = mockWsInstance;

      // Two ping periods with no answer: probe at 1000 fails at 1200, probe at
      // 2000 fails at 2200 and trips the threshold.
      await vi.advanceTimersByTimeAsync(2300);

      expect(deadSocket.readyState).not.toBe(MockWebSocket.OPEN);

      // The existing onclose machinery must be what recovers, so a replacement
      // socket appears after the backoff.
      await vi.advanceTimersByTimeAsync(300);
      expect(mockWsInstance).not.toBe(deadSocket);

      sendReadyEvent();
      expect(conn.isConnected()).toBe(true);

      conn.close();
    });

    it('detects the dead socket long before the request timeout would', async () => {
      // The point of a short probe budget: inheriting requestTimeout (120s in
      // prod) makes a liveness check that cannot detect anything in time to help.
      const conn = await connectReady();
      const deadSocket = mockWsInstance;

      await vi.advanceTimersByTimeAsync(2300);

      expect(deadSocket.readyState).not.toBe(MockWebSocket.OPEN);
      expect(2300).toBeLessThan(liveConfig.requestTimeout!);

      conn.close();
    });

    it('never force-closes a socket that answers its pings', async () => {
      const conn = await connectReady();
      const socket = mockWsInstance;

      for (let i = 0; i < 5; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        pong();
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(conn.isConnected()).toBe(true);
      expect(mockWsInstance).toBe(socket);
      expect(socket.readyState).toBe(MockWebSocket.OPEN);

      conn.close();
    });

    it('tolerates a single lost pong, and a later answer clears the count', async () => {
      // One dropped answer is a slow sidecar or a GC pause, not a dead path.
      // Killing the socket on it would trade a rare stall for frequent churn.
      const conn = await connectReady();
      const socket = mockWsInstance;

      await vi.advanceTimersByTimeAsync(1300);
      expect(socket.readyState).toBe(MockWebSocket.OPEN);

      // Second probe is answered, which must reset the run of failures...
      await vi.advanceTimersByTimeAsync(700);
      pong();
      await vi.advanceTimersByTimeAsync(0);

      // ...so the next single failure is again only the first of its run.
      await vi.advanceTimersByTimeAsync(1300);
      expect(socket.readyState).toBe(MockWebSocket.OPEN);
      expect(conn.isConnected()).toBe(true);

      conn.close();
    });

    it('does not misread a ping killed by a genuine close as a half-open socket', async () => {
      // With the readiness barrier in place a request can fail while the client
      // is legitimately between sockets. Such a failure says nothing about
      // liveness — the close has already scheduled a reconnect — and acting on it
      // would close the healthy replacement and start a second reconnect.
      const conn = await connectReady();
      const firstSocket = mockWsInstance;

      // Probe goes out, then the socket really drops with the ping in flight.
      await vi.advanceTimersByTimeAsync(1000);
      firstSocket.simulateClose(1006, 'Connection lost');

      await vi.advanceTimersByTimeAsync(300);
      const secondSocket = mockWsInstance;
      expect(secondSocket).not.toBe(firstSocket);

      sendReadyEvent();
      await vi.advanceTimersByTimeAsync(0);

      // Exactly one reconnect, and the replacement is left alone.
      expect(conn.isConnected()).toBe(true);
      expect(secondSocket.readyState).toBe(MockWebSocket.OPEN);

      // The failed in-flight ping must not have been carried into the new
      // socket's failure run either: one unanswered probe here is still only one.
      await vi.advanceTimersByTimeAsync(1300);
      expect(mockWsInstance).toBe(secondSocket);
      expect(secondSocket.readyState).toBe(MockWebSocket.OPEN);

      conn.close();
    });

    it('stops probing once the socket is gone, so exhaustion cannot be re-triggered', async () => {
      const conn = await connectReady({ ...liveConfig, maxReconnectAttempts: 1 });

      // Replacements must not reach open, or the attempt counter resets.
      MockWebSocket.autoOpen = false;

      mockWsInstance.simulateClose(1006, 'Connection lost');
      await vi.advanceTimersByTimeAsync(300);
      mockWsInstance.simulateClose(1006, 'Connection lost again');
      await vi.advanceTimersByTimeAsync(300);

      const exhaustedSocket = mockWsInstance;

      // Many ping periods with no live socket must produce no probes and no
      // further sockets: the probe is not a second source of reconnects.
      await vi.advanceTimersByTimeAsync(10000);

      expect(mockWsInstance).toBe(exhaustedSocket);

      const result = await conn.request({ type: 'fs:read:req' as any, payload: {} }).catch((e: Error) => e);
      expect((result as Error).message).toMatch(/exhaust/i);

      conn.close();
    });

    it('fails callers fast after a half-open kill when reconnect is disabled', async () => {
      // No reconnect means no storm to worry about, but the kill still earns its
      // keep: callers learn the truth immediately instead of after 120s.
      const conn = await connectReady({ ...liveConfig, reconnect: false });
      const socket = mockWsInstance;

      await vi.advanceTimersByTimeAsync(2300);

      expect(socket.readyState).not.toBe(MockWebSocket.OPEN);
      expect(conn.isConnected()).toBe(false);
      expect(mockWsInstance).toBe(socket);

      const result = await conn.request({ type: 'fs:read:req' as any, payload: {} }).catch((e: Error) => e);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toMatch(/not connected/i);

      conn.close();
    });
  });

  describe('close()', () => {
    it('should close the WebSocket and reject pending requests', async () => {
      const conn = new RuntimeConnectionImpl(defaultConfig);
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;

      const requestPromise = conn.request({
        type: 'fs:read:req' as any,
        payload: { path: '/test' },
      });

      conn.close();

      await expect(requestPromise).rejects.toThrow('Connection closed by client');
      expect(conn.isConnected()).toBe(false);
    });
  });

  describe('reconnection', () => {
    it('should attempt reconnect after unexpected close', async () => {
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        reconnect: true,
        reconnectInterval: 100,
        maxReconnectAttempts: 3,
      });

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;

      // Simulate unexpected disconnect
      mockWsInstance.simulateClose(1006, 'Connection lost');

      // Advance past reconnect delay
      await vi.advanceTimersByTimeAsync(200);

      // A new WebSocket should have been created
      expect(mockWsInstance.url).toContain('ws://localhost:8080');

      conn.close();
    });

    it('should not reconnect when close() is called explicitly', async () => {
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        reconnect: true,
        reconnectInterval: 100,
      });

      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;

      const previousUrl = mockWsInstance.url;
      conn.close();

      await vi.advanceTimersByTimeAsync(500);

      // Should not have created a new WebSocket
      expect(mockWsInstance.url).toBe(previousUrl);
    });
  });

  /**
   * A container serves exactly one session for its lifetime and refuses every
   * other one with 4003 (4001 from older sidecars). That is worth a few
   * re-signed retries (the task's assignment tag can take a moment to be
   * readable) but never the full reconnect budget against a container that will
   * never accept this session.
   */
  describe('session refused by the container', () => {
    const SIGNED = 'wss://vibe.test/ws/sess-1?Policy=pol&Signature=SECRETSIG&Key-Pair-Id=K2';

    async function refuseCurrent(code = 4003) {
      await vi.advanceTimersByTimeAsync(10);
      mockWsInstance.simulateClose(code, code === 4003 ? 'Not assigned' : 'Wrong container');
    }

    it('re-signs the URL and retries, then connects once the container accepts', async () => {
      const refreshEndpoint = vi.fn().mockResolvedValue('wss://vibe.test/ws/sess-1?Policy=fresh');
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        wsEndpoint: SIGNED,
        reconnect: true,
        reconnectInterval: 100,
        refreshEndpoint,
      });
      const p = conn.connect();

      await refuseCurrent();
      await vi.advanceTimersByTimeAsync(500);

      expect(refreshEndpoint).toHaveBeenCalledTimes(1);
      expect(mockWsInstance.url).toBe('wss://vibe.test/ws/sess-1?Policy=fresh');

      sendReadyEvent();
      await p;
      expect(conn.isConnected()).toBe(true);
      conn.close();
    });

    it.each([4003, 4001])('gives up after a few refusals (code %i) with a clear error, not the full reconnect budget', async (code) => {
      const onSessionRefused = vi.fn();
      const refreshEndpoint = vi.fn().mockResolvedValue(undefined);
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        wsEndpoint: SIGNED,
        reconnect: true,
        reconnectInterval: 100,
        maxReconnectAttempts: 10,
        maxRefusedRetries: 2,
        refreshEndpoint,
        onSessionRefused,
      });
      const result = conn.connect().catch((e: Error) => e);

      for (let i = 0; i < 3; i++) {
        await refuseCurrent(code);
        await vi.advanceTimersByTimeAsync(1000);
      }

      const err = await result;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/refused this session/i);
      expect(onSessionRefused).toHaveBeenCalledTimes(1);
      // Two retries after the first refusal, then stop.
      expect(refreshEndpoint).toHaveBeenCalledTimes(2);

      // Nothing keeps dialling in the background.
      const lastSocket = mockWsInstance;
      await vi.advanceTimersByTimeAsync(60000);
      expect(mockWsInstance).toBe(lastSocket);

      // And callers are told why rather than left waiting.
      await expect(conn.whenReady()).rejects.toThrow(/refused this session/i);
    });

    it('also stops a background reconnect that the container refuses', async () => {
      const onSessionRefused = vi.fn();
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        reconnect: true,
        reconnectInterval: 100,
        maxRefusedRetries: 1,
        onSessionRefused,
      });
      const p = conn.connect();
      await vi.advanceTimersByTimeAsync(10);
      sendReadyEvent();
      await p;

      // The task retired; every reconnect is now refused.
      mockWsInstance.simulateClose(1006, 'Connection lost');
      await vi.advanceTimersByTimeAsync(300);
      await refuseCurrent();
      await vi.advanceTimersByTimeAsync(1000);
      await refuseCurrent();
      await vi.advanceTimersByTimeAsync(1000);

      expect(onSessionRefused).toHaveBeenCalledTimes(1);
      await expect(conn.whenReady()).rejects.toThrow(/refused this session/i);
    });

    it('never puts the signed URL in an error message', async () => {
      const conn = new RuntimeConnectionImpl({ ...defaultConfig, wsEndpoint: SIGNED, reconnect: false });
      const result = conn.connect().catch((e: Error) => e);

      await vi.advanceTimersByTimeAsync(10);
      mockWsInstance.simulateError();

      const err = (await result) as Error;
      expect(err.message).not.toContain('SECRETSIG');
      expect(err.message).not.toContain('Policy=');
      expect(err.message).toContain('wss://vibe.test/ws/sess-1');
    });
  });

  describe('redactWsUrl', () => {
    it('drops the query string, which carries the CloudFront signature', () => {
      expect(redactWsUrl('wss://vibe.test/ws/sess-1?Policy=p&Signature=s&Key-Pair-Id=k')).toBe('wss://vibe.test/ws/sess-1');
    });

    it('returns a placeholder for something it cannot parse', () => {
      expect(redactWsUrl('not a url?Signature=s')).toBe('[unparseable url]');
    });
  });
});

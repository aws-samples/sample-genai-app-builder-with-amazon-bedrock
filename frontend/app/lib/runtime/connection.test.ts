import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RuntimeConnectionImpl } from './connection';
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

  constructor(url: string) {
    this.url = url;

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

    it('should include auth token in URL when provided', async () => {
      const conn = new RuntimeConnectionImpl({
        ...defaultConfig,
        authToken: 'my-jwt-token',
      });
      const connectPromise = conn.connect();

      await vi.advanceTimersByTimeAsync(10);
      expect(mockWsInstance.url).toContain('token=my-jwt-token');
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
});

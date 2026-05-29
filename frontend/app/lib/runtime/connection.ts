import { createScopedLogger } from '~/utils/logger';
import type {
  RuntimeConfig,
  RuntimeConnection,
  WSMessage,
  WSMessageHandler,
  WSRequest,
  WSResponse,
} from './types';

const logger = createScopedLogger('RuntimeConnection');

/**
 * Browser-side WebSocket client that communicates with the sidecar agent
 * running in the Fargate container. Drop-in replacement for WebContainer.
 */
export class RuntimeConnectionImpl implements RuntimeConnection {
  #ws: WebSocket | null = null;
  #config: RuntimeConfig;
  #handlers = new Map<string, Set<WSMessageHandler>>();
  #pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  #session = { sessionId: '', containerId: '', workdir: '' };
  #pingInterval: ReturnType<typeof setInterval> | null = null;
  #reconnectAttempts = 0;
  #closed = false;
  #connectPromise: Promise<void> | null = null;

  constructor(config: RuntimeConfig) {
    this.#config = {
      reconnect: true,
      reconnectInterval: 1000,
      maxReconnectAttempts: 10,
      requestTimeout: 120000,
      pingInterval: 30000,
      ...config,
    };
  }

  /**
   * Connect to the sidecar agent WebSocket. Resolves when system:ready is received.
   */
  async connect(): Promise<void> {
    if (this.#connectPromise) {
      return this.#connectPromise;
    }

    this.#closed = false;
    this.#connectPromise = this.#doConnect();

    try {
      await this.#connectPromise;
    } finally {
      this.#connectPromise = null;
    }
  }

  #doConnect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      logger.debug('Connecting to', this.#config.wsEndpoint);

      const url = this.#config.authToken
        ? `${this.#config.wsEndpoint}?token=${encodeURIComponent(this.#config.authToken)}`
        : this.#config.wsEndpoint;

      this.#ws = new WebSocket(url);

      const connectTimeout = setTimeout(() => {
        this.#ws?.close();
        reject(new Error('Connection timeout'));
      }, this.#config.requestTimeout!);

      this.#ws.onopen = () => {
        logger.debug('WebSocket connected');
        this.#reconnectAttempts = 0;
      };

      this.#ws.onmessage = (event: MessageEvent) => {
        let msg: WSMessage;

        try {
          msg = JSON.parse(event.data as string);
        } catch {
          logger.error('Failed to parse message:', event.data);
          return;
        }

        // Resolve the connect promise when we receive system:ready
        if (msg.type === 'system:ready:event') {
          clearTimeout(connectTimeout);
          const payload = msg.payload as { sessionId: string; containerId: string; workdir: string };
          this.#session = payload;
          this.#startPingInterval();
          logger.debug('Runtime ready:', payload);
          resolve();
        }

        // Resolve pending request/response pairs
        if (msg.type.endsWith(':res')) {
          const res = msg as WSResponse;
          const pending = this.#pending.get(res.requestId);

          if (pending) {
            this.#pending.delete(res.requestId);
            clearTimeout(pending.timer);

            if (res.error) {
              pending.reject(new Error(res.error.message));
            } else {
              pending.resolve(res);
            }
          }
        }

        // Dispatch to event handlers
        const handlers = this.#handlers.get(msg.type);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(msg);
            } catch (err) {
              logger.error('Handler error for', msg.type, err);
            }
          }
        }

        // Also dispatch to wildcard handlers (useful for debugging)
        const wildcardHandlers = this.#handlers.get('*');
        if (wildcardHandlers) {
          for (const handler of wildcardHandlers) {
            try {
              handler(msg);
            } catch (err) {
              logger.error('Wildcard handler error:', err);
            }
          }
        }
      };

      this.#ws.onclose = (event: CloseEvent) => {
        logger.debug('WebSocket closed:', event.code, event.reason);
        this.#stopPingInterval();
        this.#rejectAllPending('Connection closed');

        if (!this.#closed && this.#config.reconnect) {
          this.#scheduleReconnect();
        }
      };

      this.#ws.onerror = () => {
        clearTimeout(connectTimeout);

        // Only reject on initial connect; reconnects are handled by onclose
        if (this.#reconnectAttempts === 0) {
          reject(new Error(`WebSocket connection failed to ${this.#config.wsEndpoint}`));
        }
      };
    });
  }

  /**
   * Send a request and wait for the matching response.
   */
  async request<T extends WSResponse = WSResponse>(
    req: Omit<WSRequest, 'id' | 'timestamp'>
  ): Promise<T> {
    if (!this.isConnected()) {
      throw new Error('Not connected');
    }

    const id = crypto.randomUUID();
    const message = { ...req, id, timestamp: Date.now() };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Request timeout: ${req.type}`));
      }, this.#config.requestTimeout!);

      this.#pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      });

      this.#ws!.send(JSON.stringify(message));
    });
  }

  /**
   * Subscribe to events by type. Use '*' for all messages.
   */
  on(eventType: string, handler: WSMessageHandler): void {
    if (!this.#handlers.has(eventType)) {
      this.#handlers.set(eventType, new Set());
    }

    this.#handlers.get(eventType)!.add(handler);
  }

  /**
   * Unsubscribe from events.
   */
  off(eventType: string, handler: WSMessageHandler): void {
    this.#handlers.get(eventType)?.delete(handler);
  }

  isConnected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.#closed = true;
    this.#stopPingInterval();
    this.#rejectAllPending('Connection closed by client');
    this.#ws?.close();
    this.#ws = null;
  }

  getSession() {
    return { ...this.#session };
  }

  #startPingInterval(): void {
    this.#stopPingInterval();

    this.#pingInterval = setInterval(() => {
      if (this.isConnected()) {
        this.request({ type: 'system:ping:req' as any, payload: {} }).catch((err) => {
          logger.debug('Ping failed:', err.message);
        });
      }
    }, this.#config.pingInterval!);
  }

  #stopPingInterval(): void {
    if (this.#pingInterval) {
      clearInterval(this.#pingInterval);
      this.#pingInterval = null;
    }
  }

  #rejectAllPending(reason: string): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }

    this.#pending.clear();
  }

  #scheduleReconnect(): void {
    const maxAttempts = this.#config.maxReconnectAttempts!;

    if (this.#reconnectAttempts >= maxAttempts) {
      logger.error(`Max reconnect attempts (${maxAttempts}) reached`);
      return;
    }

    this.#reconnectAttempts++;

    // Exponential backoff with jitter: base * 2^attempt + random(0..base)
    const base = this.#config.reconnectInterval!;
    const delay = Math.min(base * Math.pow(2, this.#reconnectAttempts - 1), 30000) + Math.random() * base;

    logger.debug(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.#reconnectAttempts}/${maxAttempts})`);

    setTimeout(() => {
      if (this.#closed) {
        return;
      }

      this.connect().catch((err) => {
        logger.error('Reconnect failed:', err.message);
      });
    }, delay);
  }
}

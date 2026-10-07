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
 * Reasons a connection is dead rather than merely between sockets. Both keep the
 * 'Not connected' prefix callers and tests already match on, and both name which
 * of the two failures it was so a report is actionable.
 */
const PERMANENTLY_CLOSED = 'Not connected: the connection was closed by the client';
const RECONNECT_DISABLED = 'Not connected: the socket is not open and automatic reconnect is disabled';

function reconnectExhaustedMessage(maxAttempts: number): string {
  return `Not connected: reconnect attempts exhausted after ${maxAttempts} tries`;
}

/**
 * Unanswered pings in a row before the socket is declared dead.
 *
 * One is too eager: a single answer can go missing to a GC pause or a briefly
 * busy sidecar, and killing the socket for that trades a rare stall for regular
 * churn. Two bounds detection at roughly `pingInterval + pingTimeout` past the
 * first missed answer, which is well inside the request timeout it replaces.
 */
const PING_FAILURES_BEFORE_DEAD = 2;

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

  /**
   * Set when `#scheduleReconnect` gives up. `#reconnectAttempts` alone cannot
   * tell us this: it is reset the moment a socket opens, so a socket that opens
   * and dies before announcing readiness would keep refilling the budget.
   */
  #reconnectExhausted = false;

  /**
   * Unanswered pings in a row on the *current* socket. Reset by any answered
   * ping and by every fresh ping interval, so only a genuine run counts.
   */
  #pingFailures = 0;

  /**
   * Callers parked in {@link whenReady} until the socket is usable again.
   *
   * These are deliberately kept out of `#pending`: `#pending` holds requests the
   * sidecar has already been told about, and `#rejectAllPending` fails them on
   * close because a half-executed request is not safe to replay. A request that
   * has not been sent yet has no such problem, so it must survive the close that
   * it is waiting out.
   */
  #readyWaiters = new Set<{ resolve: () => void; reject: (e: Error) => void }>();

  constructor(config: RuntimeConfig) {
    this.#config = {
      reconnect: true,
      reconnectInterval: 1000,
      maxReconnectAttempts: 10,
      requestTimeout: 120000,
      pingInterval: 30000,
      pingTimeout: 10000,
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
    this.#reconnectExhausted = false;
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

      // The endpoint is a CloudFront signed URL and is dialled exactly as issued:
      // the signature is what authorises the upgrade. No user credential is added
      // to it — a bearer token in a URL ends up in CloudFront and ALB access logs.
      this.#ws = new WebSocket(this.#config.wsEndpoint);

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
          this.#releaseReadyWaiters();
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
        this.#handleDisconnect();
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
   * Resolve once the socket is open and the runtime has announced itself ready.
   *
   * Resolves synchronously-ish (next microtask) when already connected, so the
   * happy path pays nothing. Otherwise the caller is parked until the next
   * `system:ready:event`, and rejected only when the connection is genuinely
   * dead — closed by the client, or out of reconnect attempts.
   *
   * `timeoutMs` is an optional bound for callers that want one; `request()` does
   * not use it because it already owns an outer timer.
   */
  whenReady(timeoutMs?: number): Promise<void> {
    if (this.isConnected()) {
      return Promise.resolve();
    }

    const deadReason = this.#permanentFailureReason();

    if (deadReason) {
      return Promise.reject(new Error(deadReason));
    }

    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          reject(err);
        },
      };

      const timer =
        timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              this.#readyWaiters.delete(waiter);
              reject(new Error(`Timed out after ${timeoutMs}ms waiting for the connection to become ready`));
            }, timeoutMs);

      this.#readyWaiters.add(waiter);
    });
  }

  /**
   * Send a request and wait for the matching response.
   *
   * A transient reconnect must not surface to the caller. If the socket is not
   * open we wait on {@link whenReady} and send when it comes back, rather than
   * failing — a WebSocket flap of a few hundred milliseconds used to reject the
   * first write of an artifact, which then let the build run against an empty
   * directory.
   *
   * The wait counts *inside* `timeoutMs`: the timer starts before we wait, so
   * the number a caller passes stays the total budget it asked for rather than
   * silently becoming "my budget plus however long reconnect takes".
   *
   * We wait for readiness instead of queueing the payload in an outbox. An
   * outbox would buy nothing here — the caller is already suspended on this
   * promise, so there is no throughput to reclaim — while forcing decisions
   * about replay ordering against newer requests and about frames whose
   * meaning has expired. Waiting keeps the invariant that a frame is only ever
   * on the wire when the socket is open.
   */
  async request<T extends WSResponse = WSResponse>(
    req: Omit<WSRequest, 'id' | 'timestamp'>,
    /**
     * Override the configured timeout for this one request.
     *
     * A cold `npm install` can outlast any timeout sensible for an ordinary
     * request, and raising the global one would delay every real failure.
     */
    timeoutMs?: number,
  ): Promise<T> {
    const id = crypto.randomUUID();
    const message = { ...req, id, timestamp: Date.now() };

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        settled = true;
        this.#pending.delete(id);
        reject(new Error(`Request timeout: ${req.type}`));
      }, timeoutMs ?? this.#config.requestTimeout!);

      const dispatch = () => {
        this.#pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
          timer,
        });

        this.#ws!.send(JSON.stringify(message));
      };

      if (this.isConnected()) {
        dispatch();
        return;
      }

      this.whenReady().then(
        () => {
          // The outer timer may have fired while we were parked.
          if (settled) {
            return;
          }

          dispatch();
        },
        (err: Error) => {
          if (settled) {
            return;
          }

          settled = true;
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Send a message without awaiting a response. Used for relay-style traffic
   * (the `yjs:*` collaboration frames) that the server fans out to peers with
   * no reply. Silently drops the message if the socket is not open — Yjs
   * resynchronises from scratch on the next reconnect, so a lost frame while
   * offline is safe.
   */
  send(req: Omit<WSRequest, 'id' | 'timestamp'>): void {
    if (!this.isConnected()) {
      return;
    }

    const message = { ...req, id: crypto.randomUUID(), timestamp: Date.now() };
    this.#ws!.send(JSON.stringify(message));
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
    this.#rejectReadyWaiters(new Error(PERMANENTLY_CLOSED));
    this.#ws?.close();
    this.#ws = null;
  }

  getSession() {
    return { ...this.#session };
  }

  /**
   * Everything that has to happen when the socket stops being usable.
   *
   * Shared by `onclose` and by the half-open kill in {@link #declareDead}, so a
   * forced close recovers through exactly the same path as a real drop and there
   * is only one place that decides to reconnect.
   */
  #handleDisconnect(): void {
    this.#stopPingInterval();
    this.#rejectAllPending('Connection closed');

    if (!this.#closed && this.#config.reconnect) {
      this.#scheduleReconnect();
    }
  }

  /**
   * Probe the socket, and treat a run of unanswered probes as a dead socket.
   *
   * This is the only detector for a half-open connection: with the TCP path gone
   * but no FIN received, `readyState` stays OPEN, so `isConnected()` is true, the
   * readiness barrier takes its fast path, and requests fail on their own
   * timeout rather than as connection errors. Nothing schedules a reconnect
   * because `onclose` never fires.
   *
   * The probe gets `pingTimeout` rather than `requestTimeout` for its budget: a
   * liveness check has to fail fast enough to be worth having, and a budget well
   * under `pingInterval` also keeps probes from overlapping, so `#pingFailures`
   * counts consecutive periods rather than a pile-up.
   */
  #startPingInterval(): void {
    this.#stopPingInterval();
    this.#pingFailures = 0;

    this.#pingInterval = setInterval(() => {
      if (!this.isConnected()) {
        return;
      }

      // Remember which socket we are probing: the answer, or lack of one, is
      // only evidence about this socket.
      const probed = this.#ws;

      this.request({ type: 'system:ping:req' as any, payload: {} }, this.#config.pingTimeout!).then(
        () => {
          if (this.#ws === probed) {
            this.#pingFailures = 0;
          }
        },
        (err: Error) => this.#onPingFailure(probed, err),
      );
    }, this.#config.pingInterval!);
  }

  #onPingFailure(probed: WebSocket | null, err: Error): void {
    /*
     * A ping can fail for reasons that say nothing about the socket's health:
     * the socket closed for real with the ping in flight (`#rejectAllPending`
     * fails it, and that close already scheduled a reconnect), or the readiness
     * barrier parked the request and it ran out of time while the client was
     * legitimately between sockets. In both cases the socket we probed is no
     * longer the current, open one — so requiring that identity is what keeps a
     * transient reconnect from being read as a dead path, and stops us closing a
     * healthy replacement and triggering a second reconnect.
     */
    if (this.#closed || this.#ws !== probed || !this.isConnected()) {
      logger.debug('Ignoring a ping failure on a socket that is already gone:', err.message);
      return;
    }

    this.#pingFailures++;

    if (this.#pingFailures < PING_FAILURES_BEFORE_DEAD) {
      logger.debug(`Ping failed (${this.#pingFailures}/${PING_FAILURES_BEFORE_DEAD}):`, err.message);
      return;
    }

    logger.warn(`Ping unanswered ${this.#pingFailures} times, treating the connection as dead:`, err.message);
    this.#declareDead(probed!);
  }

  /**
   * Retire a socket that is open but not carrying traffic.
   *
   * `close()` alone is not enough to drive recovery. On a dead path the close
   * handshake has nothing to talk to, so the socket can sit in CLOSING for as
   * long as the OS keeps retransmitting and `onclose` may be minutes away —
   * which is the very delay we are trying to avoid. So we detach the socket's
   * handlers, ask it to close for tidiness, and run the disconnect path
   * ourselves. Detaching also means a late `onclose` cannot arrive and schedule
   * a second reconnect.
   *
   * No storm is possible: `#handleDisconnect` stops the ping interval, and the
   * interval is only ever restarted by a `system:ready:event` on a new socket,
   * so nothing probes during backoff. Reconnect accounting is untouched — this
   * spends `#reconnectAttempts` exactly as a real drop would, and an exhausted
   * budget leaves no open socket to probe, so it cannot be re-triggered.
   */
  #declareDead(socket: WebSocket): void {
    socket.onclose = null;
    socket.onmessage = null;
    socket.onerror = null;

    try {
      socket.close();
    } catch (closeErr) {
      logger.debug('Closing the dead socket threw, continuing:', closeErr);
    }

    this.#handleDisconnect();
  }

  #stopPingInterval(): void {
    if (this.#pingInterval) {
      clearInterval(this.#pingInterval);
      this.#pingInterval = null;
    }
  }

  /**
   * Why waiting for readiness would be futile, or null if a recovery is still
   * plausible. Kept in one place so `whenReady` and the waiter rejections agree.
   */
  #permanentFailureReason(): string | null {
    if (this.#closed) {
      return PERMANENTLY_CLOSED;
    }

    if (this.#reconnectExhausted) {
      return reconnectExhaustedMessage(this.#config.maxReconnectAttempts!);
    }

    // Without reconnect nothing will reopen the socket, unless a connect is
    // already in flight — a request racing the initial connect should wait.
    if (!this.#config.reconnect && !this.#connectPromise) {
      return RECONNECT_DISABLED;
    }

    return null;
  }

  #releaseReadyWaiters(): void {
    const waiters = [...this.#readyWaiters];
    this.#readyWaiters.clear();

    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  #rejectReadyWaiters(err: Error): void {
    const waiters = [...this.#readyWaiters];
    this.#readyWaiters.clear();

    for (const waiter of waiters) {
      waiter.reject(err);
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

      // Nothing will reopen the socket now, so anyone parked on the readiness
      // barrier has to be told rather than left to time out.
      this.#reconnectExhausted = true;
      this.#rejectReadyWaiters(new Error(reconnectExhaustedMessage(maxAttempts)));

      return;
    }

    this.#reconnectAttempts++;

    // Exponential backoff with jitter: base * 2^attempt + random(0..base)
    const base = this.#config.reconnectInterval!;
    const delay = Math.min(base * Math.pow(2, this.#reconnectAttempts - 1), 30000) + Math.random() * base;

    logger.debug(`Reconnecting in ${Math.round(delay)}ms (attempt ${this.#reconnectAttempts}/${maxAttempts})`);

    setTimeout(async () => {
      if (this.#closed) {
        return;
      }

      // The endpoint's signed URL is short-lived and backoff can outlast it,
      // so ask for a fresh one before retrying. Failing to refresh is not fatal —
      // the existing endpoint may still be valid.
      if (this.#config.refreshEndpoint) {
        try {
          const refreshed = await this.#config.refreshEndpoint();
          if (refreshed) {
            this.#config.wsEndpoint = refreshed;
          }
        } catch (err) {
          logger.warn('Could not refresh the connection endpoint:', err);
        }
      }

      this.connect().then(() => {
        logger.debug('Reconnected successfully');
        const handlers = this.#handlers.get('system:reconnected');
        if (handlers) {
          const msg = { type: 'system:reconnected', id: '', timestamp: Date.now(), payload: {} } as WSMessage;
          for (const handler of handlers) {
            try { handler(msg); } catch (err) { logger.error('Reconnect handler error:', err); }
          }
        }
      }).catch((err) => {
        logger.error('Reconnect failed:', err.message);
      });
    }, delay);
  }
}

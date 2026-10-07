import type { RuntimeConnection, WSMessageHandler } from '~/lib/runtime/types';

/**
 * The two message types that carry collaboration frames. The sidecar relay
 * fans these out verbatim to every other peer in the same session (see
 * `infra/lib/sandbox-container/agent/src/room-registry.ts`), so a peer
 * receives a frame under the SAME type the sender used.
 */
export const YJS_SYNC_TYPE = 'yjs:sync:req' as const;
export const YJS_AWARENESS_TYPE = 'yjs:awareness:req' as const;

/** A collaboration channel: document sync vs. ephemeral presence. */
export type CollabChannel = 'sync' | 'awareness';

/**
 * Transport-agnostic bus for collaboration frames. Decoupling the provider
 * from the WebSocket lets the sync/awareness protocol be unit-tested with an
 * in-memory relay — no sockets, no sandbox.
 *
 * Frames are raw bytes; base64 (de)serialization for the wire lives in the
 * concrete transport, not the provider.
 */
export interface CollabTransport {
  /** Broadcast a frame to peers on the given channel. */
  send(channel: CollabChannel, data: Uint8Array): void;
  /** Subscribe to inbound frames on a channel. */
  on(channel: CollabChannel, handler: (data: Uint8Array) => void): void;
  /** Unsubscribe a handler. */
  off(channel: CollabChannel, handler: (data: Uint8Array) => void): void;
  /** Register a callback invoked whenever the underlying link reconnects. */
  onReconnect(handler: () => void): void;
  /** Whether the underlying link is currently usable. */
  isConnected(): boolean;
}

const CHANNEL_TYPE: Record<CollabChannel, string> = {
  sync: YJS_SYNC_TYPE,
  awareness: YJS_AWARENESS_TYPE,
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Adapts the sidecar {@link RuntimeConnection} to a {@link CollabTransport}:
 * wraps each frame in the `{ data: <base64> }` WSMessage envelope the relay
 * expects and decodes inbound frames back to bytes.
 *
 * Uses the connection's fire-and-forget `send()` — collaboration frames get
 * no `:res`, so `request()` (which awaits a reply) must not be used.
 */
export class RuntimeCollabTransport implements CollabTransport {
  #connection: RuntimeConnection;
  // Map each caller handler to the WSMessageHandler we registered, so `off`
  // can remove the exact wrapper we added.
  #wrappers = new Map<(data: Uint8Array) => void, WSMessageHandler>();

  constructor(connection: RuntimeConnection) {
    this.#connection = connection;
  }

  send(channel: CollabChannel, data: Uint8Array): void {
    this.#connection.send({
      type: CHANNEL_TYPE[channel] as `${string}:req`,
      payload: { data: toBase64(data) },
    });
  }

  on(channel: CollabChannel, handler: (data: Uint8Array) => void): void {
    const wrapper: WSMessageHandler = (msg) => {
      const raw = (msg.payload as { data?: unknown } | undefined)?.data;
      if (typeof raw !== 'string') {
        return;
      }
      handler(fromBase64(raw));
    };

    this.#wrappers.set(handler, wrapper);
    this.#connection.on(CHANNEL_TYPE[channel], wrapper);
  }

  off(channel: CollabChannel, handler: (data: Uint8Array) => void): void {
    const wrapper = this.#wrappers.get(handler);
    if (wrapper) {
      this.#connection.off(CHANNEL_TYPE[channel], wrapper);
      this.#wrappers.delete(handler);
    }
  }

  onReconnect(handler: () => void): void {
    // The connection re-emits this synthetic event after a successful reconnect.
    this.#connection.on('system:reconnected', () => handler());
  }

  isConnected(): boolean {
    return this.#connection.isConnected();
  }
}

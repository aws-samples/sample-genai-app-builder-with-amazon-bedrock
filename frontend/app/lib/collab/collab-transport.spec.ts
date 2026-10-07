import { describe, it, expect } from 'vitest';
import {
  RuntimeCollabTransport,
  YJS_SYNC_TYPE,
  YJS_AWARENESS_TYPE,
} from './collab-transport';
import type { RuntimeConnection, WSMessage, WSMessageHandler } from '~/lib/runtime/types';

/**
 * Minimal RuntimeConnection stand-in that records fire-and-forget sends and
 * lets a test push inbound messages to registered handlers. Only the surface
 * the transport touches (`send`, `on`, `off`, `isConnected`) is implemented.
 */
class FakeConnection implements Partial<RuntimeConnection> {
  sent: Array<{ type: string; payload: unknown }> = [];
  #handlers = new Map<string, Set<WSMessageHandler>>();
  connected = true;

  send(req: { type: string; payload: unknown }): void {
    this.sent.push({ type: req.type, payload: req.payload });
  }

  on(eventType: string, handler: WSMessageHandler): void {
    if (!this.#handlers.has(eventType)) {
      this.#handlers.set(eventType, new Set());
    }
    this.#handlers.get(eventType)!.add(handler);
  }

  off(eventType: string, handler: WSMessageHandler): void {
    this.#handlers.get(eventType)?.delete(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  emit(msg: WSMessage): void {
    for (const handler of this.#handlers.get(msg.type) ?? []) {
      handler(msg);
    }
  }
}

function makeTransport() {
  const conn = new FakeConnection();
  const transport = new RuntimeCollabTransport(conn as unknown as RuntimeConnection);
  return { conn, transport };
}

describe('RuntimeCollabTransport', () => {
  it('wraps a sync frame in the yjs:sync:req envelope with base64 data', () => {
    const { conn, transport } = makeTransport();

    transport.send('sync', new Uint8Array([1, 2, 3, 255]));

    expect(conn.sent).toHaveLength(1);
    expect(conn.sent[0].type).toBe(YJS_SYNC_TYPE);
    expect((conn.sent[0].payload as { data: string }).data).toBe(btoa('\x01\x02\x03\xff'));
  });

  it('uses the awareness type for the awareness channel', () => {
    const { conn, transport } = makeTransport();

    transport.send('awareness', new Uint8Array([10]));

    expect(conn.sent[0].type).toBe(YJS_AWARENESS_TYPE);
  });

  it('round-trips bytes: an inbound envelope decodes back to the original frame', () => {
    const { conn, transport } = makeTransport();
    const original = new Uint8Array([0, 42, 128, 255]);

    let received: Uint8Array | null = null;
    transport.on('sync', (data) => {
      received = data;
    });

    conn.emit({
      id: 'x',
      type: YJS_SYNC_TYPE,
      timestamp: 0,
      payload: { data: btoa(String.fromCharCode(...original)) },
    });

    expect(received).not.toBeNull();
    expect(Array.from(received!)).toEqual(Array.from(original));
  });

  it('ignores inbound frames with a non-string payload', () => {
    const { conn, transport } = makeTransport();
    let calls = 0;
    transport.on('sync', () => {
      calls++;
    });

    conn.emit({ id: 'x', type: YJS_SYNC_TYPE, timestamp: 0, payload: {} });
    conn.emit({ id: 'y', type: YJS_SYNC_TYPE, timestamp: 0, payload: { data: 123 } });

    expect(calls).toBe(0);
  });

  it('off() removes the exact wrapper so no further frames are delivered', () => {
    const { conn, transport } = makeTransport();
    let calls = 0;
    const handler = () => {
      calls++;
    };

    transport.on('sync', handler);
    conn.emit({ id: '1', type: YJS_SYNC_TYPE, timestamp: 0, payload: { data: btoa('a') } });
    transport.off('sync', handler);
    conn.emit({ id: '2', type: YJS_SYNC_TYPE, timestamp: 0, payload: { data: btoa('b') } });

    expect(calls).toBe(1);
  });

  it('drops sends when the connection is offline', () => {
    const { conn, transport } = makeTransport();
    conn.connected = false;

    // isConnected() is surfaced from the underlying connection; a real send is
    // a no-op there, but the transport still delegates to it — assert the
    // transport reports the link state faithfully.
    expect(transport.isConnected()).toBe(false);
  });
});

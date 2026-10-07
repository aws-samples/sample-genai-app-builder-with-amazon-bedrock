import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { CollabProvider } from './collab-provider';
import type { CollabChannel, CollabTransport } from './collab-transport';

/**
 * In-memory relay that mirrors the sidecar's behaviour: a frame sent by one
 * peer is delivered to every OTHER peer on the same channel, never echoed to
 * the sender. This lets us exercise the full sync/awareness handshake with no
 * sockets and no sandbox.
 */
class FakeRelay {
  #peers = new Set<FakeTransport>();

  connect(peer: FakeTransport) {
    this.#peers.add(peer);
    peer.relay = this;
  }

  disconnect(peer: FakeTransport) {
    this.#peers.delete(peer);
  }

  broadcast(from: FakeTransport, channel: CollabChannel, data: Uint8Array) {
    for (const peer of this.#peers) {
      if (peer !== from) {
        peer.deliver(channel, data);
      }
    }
  }
}

class FakeTransport implements CollabTransport {
  relay: FakeRelay | null = null;
  connected = true;
  #handlers: Record<CollabChannel, Set<(data: Uint8Array) => void>> = {
    sync: new Set(),
    awareness: new Set(),
  };
  #reconnectHandlers = new Set<() => void>();

  send(channel: CollabChannel, data: Uint8Array): void {
    if (!this.connected || !this.relay) {
      return;
    }
    // Copy the bytes so a shared buffer can't be mutated in flight, matching
    // the real transport where frames are serialized over the wire.
    this.relay.broadcast(this, channel, data.slice());
  }

  on(channel: CollabChannel, handler: (data: Uint8Array) => void): void {
    this.#handlers[channel].add(handler);
  }

  off(channel: CollabChannel, handler: (data: Uint8Array) => void): void {
    this.#handlers[channel].delete(handler);
  }

  onReconnect(handler: () => void): void {
    this.#reconnectHandlers.add(handler);
  }

  isConnected(): boolean {
    return this.connected;
  }

  deliver(channel: CollabChannel, data: Uint8Array): void {
    for (const handler of this.#handlers[channel]) {
      handler(data);
    }
  }

  fireReconnect(): void {
    for (const handler of this.#reconnectHandlers) {
      handler();
    }
  }
}

function connectedPair() {
  const relay = new FakeRelay();
  const ta = new FakeTransport();
  const tb = new FakeTransport();
  relay.connect(ta);
  relay.connect(tb);
  return { relay, ta, tb };
}

describe('CollabProvider', () => {
  it('propagates an edit from one peer to another', () => {
    const { ta, tb } = connectedPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    const b = new CollabProvider(docB, tb);

    docA.getText('file').insert(0, 'hello');

    expect(docB.getText('file').toString()).toBe('hello');

    a.destroy();
    b.destroy();
  });

  it('converges concurrent edits from both peers (CRDT)', () => {
    const { ta, tb } = connectedPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    const b = new CollabProvider(docB, tb);

    const textA = docA.getText('file');
    const textB = docB.getText('file');

    // A types at the start, B types at the end — concurrently.
    textA.insert(0, 'AAA');
    textB.insert(textB.length, 'BBB');

    // Both replicas converge to the identical string.
    expect(textA.toString()).toBe(textB.toString());

    a.destroy();
    b.destroy();
  });

  it('syncs pre-existing content to a peer that joins late (SyncStep1 handshake)', () => {
    const relay = new FakeRelay();
    const ta = new FakeTransport();
    relay.connect(ta);

    const docA = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    docA.getText('file').insert(0, 'seeded content');

    // B joins after A already has content.
    const tb = new FakeTransport();
    relay.connect(tb);
    const docB = new Y.Doc();
    const b = new CollabProvider(docB, tb);

    // B's SyncStep1 pulls A's existing state.
    expect(docB.getText('file').toString()).toBe('seeded content');

    a.destroy();
    b.destroy();
  });

  it('reports synced=true once the handshake completes', () => {
    const relay = new FakeRelay();
    const ta = new FakeTransport();
    relay.connect(ta);
    const docA = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    docA.getText('file').insert(0, 'x');

    const tb = new FakeTransport();
    relay.connect(tb);
    const docB = new Y.Doc();
    const b = new CollabProvider(docB, tb);

    expect(b.synced).toBe(true);

    a.destroy();
    b.destroy();
  });

  it('propagates awareness (presence) state between peers', () => {
    const { ta, tb } = connectedPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    const b = new CollabProvider(docB, tb);

    a.awareness.setLocalStateField('user', { name: 'Ada', color: '#ff0000' });

    const seenOnB = Array.from(b.awareness.getStates().values()).some(
      (s: any) => s.user?.name === 'Ada',
    );
    expect(seenOnB).toBe(true);

    a.destroy();
    b.destroy();
  });

  it('clears a peer\'s presence on destroy', () => {
    const { ta, tb } = connectedPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    const b = new CollabProvider(docB, tb);

    a.awareness.setLocalStateField('user', { name: 'Ada' });
    expect(b.awareness.getStates().has(docA.clientID)).toBe(true);

    a.destroy();

    expect(b.awareness.getStates().has(docA.clientID)).toBe(false);

    b.destroy();
  });

  it('does not echo network-applied updates back to the sender', () => {
    const { ta, tb } = connectedPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    const b = new CollabProvider(docB, tb);

    // Count frames B emits. When A types, B applies the update from the
    // network; B must NOT re-broadcast it (origin === provider guard).
    let framesFromB = 0;
    const original = tb.send.bind(tb);
    tb.send = (channel, data) => {
      framesFromB++;
      original(channel, data);
    };

    docA.getText('file').insert(0, 'no echo');
    expect(docB.getText('file').toString()).toBe('no echo');
    expect(framesFromB).toBe(0);

    a.destroy();
    b.destroy();
  });

  it('re-syncs after a reconnect', () => {
    const { relay, ta, tb } = connectedPair();
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const a = new CollabProvider(docA, ta);
    const b = new CollabProvider(docB, tb);

    // B goes offline and misses an edit.
    relay.disconnect(tb);
    tb.connected = false;
    docA.getText('file').insert(0, 'while offline');
    expect(docB.getText('file').toString()).toBe('');

    // B reconnects: the reconnect hook re-runs SyncStep1 and catches up.
    tb.connected = true;
    relay.connect(tb);
    tb.fireReconnect();

    expect(docB.getText('file').toString()).toBe('while offline');

    a.destroy();
    b.destroy();
  });
});

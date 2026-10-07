import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { CollabTransport } from './collab-transport';

/**
 * Yjs provider that syncs a `Y.Doc` and an {@link Awareness} instance over an
 * arbitrary {@link CollabTransport}. The wire format is the standard
 * y-websocket sync + awareness protocol, but the transport here is our own
 * sidecar relay rather than a dedicated Yjs server.
 *
 * The relay is a dumb broadcast bus: it fans every frame to all OTHER peers in
 * the session and keeps no document of its own. So this provider implements
 * the peer-to-peer handshake directly:
 *
 *   - on start (and on each reconnect) it broadcasts SyncStep1 (its state
 *     vector); peers reply with SyncStep2 (missing updates), converging every
 *     replica regardless of who joined first;
 *   - local document changes broadcast as incremental update messages;
 *   - awareness (cursor/selection/name/color) is a separate ephemeral channel.
 *
 * `origin` tagging on `applyUpdate`/transactions prevents echo loops: updates
 * that arrived from the network are applied with this provider as their origin
 * and therefore are not re-broadcast by the local update observer.
 */
export class CollabProvider {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;

  #transport: CollabTransport;
  #synced = false;
  #destroyed = false;

  #onSyncFrame = (data: Uint8Array) => this.#handleSyncFrame(data);
  #onAwarenessFrame = (data: Uint8Array) => this.#handleAwarenessFrame(data);
  #onReconnect = () => this.#sendSyncStep1();

  #syncedListeners = new Set<(synced: boolean) => void>();

  constructor(doc: Y.Doc, transport: CollabTransport, awareness?: Awareness) {
    this.doc = doc;
    this.awareness = awareness ?? new Awareness(doc);
    this.#transport = transport;

    this.doc.on('update', this.#onDocUpdate);
    this.awareness.on('update', this.#onAwarenessUpdate);

    this.#transport.on('sync', this.#onSyncFrame);
    this.#transport.on('awareness', this.#onAwarenessFrame);
    this.#transport.onReconnect(this.#onReconnect);

    // Kick off the handshake. If the transport is offline it becomes a no-op;
    // the reconnect hook re-runs it once the link is back.
    this.#sendSyncStep1();
  }

  get synced(): boolean {
    return this.#synced;
  }

  /** Subscribe to sync-state changes (false → true on first convergence). */
  onSynced(listener: (synced: boolean) => void): () => void {
    this.#syncedListeners.add(listener);
    return () => this.#syncedListeners.delete(listener);
  }

  #setSynced(value: boolean): void {
    if (this.#synced === value) {
      return;
    }
    this.#synced = value;
    for (const listener of this.#syncedListeners) {
      listener(value);
    }
  }

  // ── Outbound ──────────────────────────────────────────────────────

  #sendSyncStep1(): void {
    if (this.#destroyed) {
      return;
    }
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.#transport.send('sync', encoding.toUint8Array(encoder));

    // Proactively share our current awareness state with peers who just
    // (re)connected so their presence UI populates without waiting for us to
    // move the cursor.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const update = encodeAwarenessUpdate(this.awareness, Array.from(states.keys()));
      this.#transport.send('awareness', update);
    }
  }

  // Local doc change → broadcast as an incremental update, unless the change
  // originated from a remote frame we just applied (origin === this).
  #onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this || this.#destroyed) {
      return;
    }
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.#transport.send('sync', encoding.toUint8Array(encoder));
  };

  #onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === 'remote' || this.#destroyed) {
      return;
    }
    const changed = added.concat(updated, removed);
    const update = encodeAwarenessUpdate(this.awareness, changed);
    this.#transport.send('awareness', update);
  };

  // ── Inbound ───────────────────────────────────────────────────────

  #handleSyncFrame(data: Uint8Array): void {
    if (this.#destroyed) {
      return;
    }
    const decoder = decoding.createDecoder(data);
    const encoder = encoding.createEncoder();

    // readSyncMessage applies the incoming step and may write a reply
    // (e.g. SyncStep1 → SyncStep2) into `encoder`. Tagging the transaction
    // origin as `this` stops #onDocUpdate re-broadcasting what we just applied.
    const messageType = syncProtocol.readSyncMessage(decoder, encoder, this.doc, this);

    if (encoding.length(encoder) > 0) {
      this.#transport.send('sync', encoding.toUint8Array(encoder));
    }

    // Receiving a SyncStep2 (or an update) means a peer has answered our
    // handshake — our replica now reflects theirs, so we're synced.
    if (messageType === syncProtocol.messageYjsSyncStep2 || messageType === syncProtocol.messageYjsUpdate) {
      this.#setSynced(true);
    }
  }

  #handleAwarenessFrame(data: Uint8Array): void {
    if (this.#destroyed) {
      return;
    }
    // `origin: 'remote'` so #onAwarenessUpdate does not echo it back.
    applyAwarenessUpdate(this.awareness, data, 'remote');
  }

  // ── Teardown ──────────────────────────────────────────────────────

  destroy(): void {
    if (this.#destroyed) {
      return;
    }

    // Tell peers we're gone so our cursor/presence is cleared from their UI.
    // This must happen BEFORE we set #destroyed / detach observers, so the
    // awareness 'update' it triggers still broadcasts the removal frame.
    removeAwarenessStates(this.awareness, [this.doc.clientID], 'local');

    this.#destroyed = true;

    this.doc.off('update', this.#onDocUpdate);
    this.awareness.off('update', this.#onAwarenessUpdate);
    this.#transport.off('sync', this.#onSyncFrame);
    this.#transport.off('awareness', this.#onAwarenessFrame);
    this.awareness.destroy();
    this.#syncedListeners.clear();
  }
}

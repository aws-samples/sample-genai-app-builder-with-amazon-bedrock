import { WebSocket } from 'ws';

/**
 * Tracks WebSocket connections grouped by room so real-time collaboration
 * frames (Yjs document sync + Awareness presence) can be fanned out to every
 * peer in the same room.
 *
 * This registry is deliberately **additive and isolation-neutral**: it does
 * NOT participate in workspace cleanup or session eviction. A "room" is keyed
 * by the identifier already carried in the `/ws/{id}` upgrade path — peers
 * that share that id are collaborators editing the same project, so grouping
 * them here never crosses the existing per-session security boundary (a
 * foreign id is still a different room and never receives another room's
 * frames).
 *
 * The registry is a pure relay: it forwards opaque payloads between peers and
 * holds no CRDT document of its own. The container filesystem remains the
 * source of truth for project content; the Yjs document is seeded from file
 * content on the client, so the server never needs to persist collaboration
 * state.
 */
export class RoomRegistry {
  #rooms = new Map<string, Set<WebSocket>>();

  /** Add a connection to a room, creating the room on first join. */
  join(roomId: string, ws: WebSocket): void {
    let members = this.#rooms.get(roomId);

    if (!members) {
      members = new Set<WebSocket>();
      this.#rooms.set(roomId, members);
    }

    members.add(ws);
  }

  /**
   * Remove a connection from a room. The room is dropped once its last member
   * leaves so `roomCount()` reflects only live rooms.
   */
  leave(roomId: string, ws: WebSocket): void {
    const members = this.#rooms.get(roomId);

    if (!members) {
      return;
    }

    members.delete(ws);

    if (members.size === 0) {
      this.#rooms.delete(roomId);
    }
  }

  /**
   * Send a raw serialized frame to every OPEN member of a room except the
   * sender. Returns the number of peers the frame was delivered to (0 when the
   * sender is alone or the room is unknown).
   */
  broadcast(roomId: string, sender: WebSocket, data: string): number {
    const members = this.#rooms.get(roomId);

    if (!members) {
      return 0;
    }

    let delivered = 0;

    for (const peer of members) {
      if (peer === sender) {
        continue;
      }

      if (peer.readyState === WebSocket.OPEN) {
        peer.send(data);
        delivered++;
      }
    }

    return delivered;
  }

  /**
   * Send a raw serialized frame to every OPEN member of a room, including the
   * peer whose action triggered it. Returns the number of peers reached.
   *
   * This is for **server-originated events** — file changes, shell output,
   * detected ports — which have no "sender" to exclude: every collaborator
   * needs them to keep a consistent view of the workspace. Contrast
   * {@link broadcast}, which relays a frame *from* one peer and must therefore
   * skip its author to avoid echoing it back.
   */
  broadcastAll(roomId: string, data: string): number {
    const members = this.#rooms.get(roomId);

    if (!members) {
      return 0;
    }

    let delivered = 0;

    for (const peer of members) {
      if (peer.readyState === WebSocket.OPEN) {
        peer.send(data);
        delivered++;
      }
    }

    return delivered;
  }

  /** Number of connections currently in a room. */
  peerCount(roomId: string): number {
    return this.#rooms.get(roomId)?.size ?? 0;
  }

  /** Number of rooms with at least one member. */
  roomCount(): number {
    return this.#rooms.size;
  }
}

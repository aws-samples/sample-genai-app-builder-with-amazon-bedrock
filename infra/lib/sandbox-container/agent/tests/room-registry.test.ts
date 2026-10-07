import { describe, it, expect } from 'vitest';
import { WebSocket } from 'ws';
import { RoomRegistry } from '../src/room-registry.js';

/**
 * A minimal stand-in for a `ws` WebSocket that records what was sent and lets
 * a test drive its `readyState`. The registry only ever touches `readyState`,
 * `send()`, and object identity, so this is sufficient — and keeps these tests
 * fast and deterministic without opening real sockets.
 */
function fakePeer(readyState: number = WebSocket.OPEN) {
  const sent: string[] = [];
  const peer = {
    readyState,
    send(data: string) {
      sent.push(data);
    },
    sent,
  };
  return peer as unknown as WebSocket & { sent: string[] };
}

describe('RoomRegistry', () => {
  it('starts empty', () => {
    const rooms = new RoomRegistry();
    expect(rooms.roomCount()).toBe(0);
    expect(rooms.peerCount('room-1')).toBe(0);
  });

  it('tracks peers joining and leaving a room', () => {
    const rooms = new RoomRegistry();
    const a = fakePeer();
    const b = fakePeer();

    rooms.join('room-1', a);
    expect(rooms.peerCount('room-1')).toBe(1);
    expect(rooms.roomCount()).toBe(1);

    rooms.join('room-1', b);
    expect(rooms.peerCount('room-1')).toBe(2);
    expect(rooms.roomCount()).toBe(1);

    rooms.leave('room-1', a);
    expect(rooms.peerCount('room-1')).toBe(1);

    rooms.leave('room-1', b);
    expect(rooms.peerCount('room-1')).toBe(0);
    // Room dropped once empty so roomCount reflects only live rooms.
    expect(rooms.roomCount()).toBe(0);
  });

  it('broadcasts a frame to every peer except the sender', () => {
    const rooms = new RoomRegistry();
    const sender = fakePeer();
    const peer2 = fakePeer();
    const peer3 = fakePeer();

    rooms.join('room-1', sender);
    rooms.join('room-1', peer2);
    rooms.join('room-1', peer3);

    const delivered = rooms.broadcast('room-1', sender, 'frame-A');

    expect(delivered).toBe(2);
    expect((sender as unknown as { sent: string[] }).sent).toEqual([]);
    expect((peer2 as unknown as { sent: string[] }).sent).toEqual(['frame-A']);
    expect((peer3 as unknown as { sent: string[] }).sent).toEqual(['frame-A']);
  });

  it('never leaks frames across rooms (isolation)', () => {
    const rooms = new RoomRegistry();
    const sender = fakePeer();
    const sameRoom = fakePeer();
    const otherRoom = fakePeer();

    rooms.join('room-1', sender);
    rooms.join('room-1', sameRoom);
    rooms.join('room-2', otherRoom);

    const delivered = rooms.broadcast('room-1', sender, 'secret');

    expect(delivered).toBe(1);
    expect((sameRoom as unknown as { sent: string[] }).sent).toEqual(['secret']);
    // A peer in a different room must never receive another room's frame.
    expect((otherRoom as unknown as { sent: string[] }).sent).toEqual([]);
  });

  it('skips peers whose socket is not OPEN', () => {
    const rooms = new RoomRegistry();
    const sender = fakePeer();
    const openPeer = fakePeer(WebSocket.OPEN);
    const closingPeer = fakePeer(WebSocket.CLOSING);

    rooms.join('room-1', sender);
    rooms.join('room-1', openPeer);
    rooms.join('room-1', closingPeer);

    const delivered = rooms.broadcast('room-1', sender, 'frame');

    expect(delivered).toBe(1);
    expect((openPeer as unknown as { sent: string[] }).sent).toEqual(['frame']);
    expect((closingPeer as unknown as { sent: string[] }).sent).toEqual([]);
  });

  it('returns 0 when broadcasting to an unknown or solo room', () => {
    const rooms = new RoomRegistry();
    const solo = fakePeer();

    expect(rooms.broadcast('missing', solo, 'x')).toBe(0);

    rooms.join('room-1', solo);
    expect(rooms.broadcast('room-1', solo, 'x')).toBe(0);
  });

  it('is a no-op to leave a room that was never joined', () => {
    const rooms = new RoomRegistry();
    const a = fakePeer();
    expect(() => rooms.leave('never', a)).not.toThrow();
    expect(rooms.roomCount()).toBe(0);
  });

  /**
   * Server-originated events (file changes, shell output, detected ports) have
   * no sender to exclude — every collaborator needs them — so they use
   * `broadcastAll` rather than `broadcast`.
   */
  describe('broadcastAll', () => {
    it('delivers to every OPEN member including the one that triggered it', () => {
      const rooms = new RoomRegistry();
      const a = fakePeer();
      const b = fakePeer();
      rooms.join('room-1', a);
      rooms.join('room-1', b);

      const delivered = rooms.broadcastAll('room-1', 'event');

      expect(delivered).toBe(2);
      expect((a as unknown as { sent: string[] }).sent).toEqual(['event']);
      expect((b as unknown as { sent: string[] }).sent).toEqual(['event']);
    });

    it('skips members whose socket is not OPEN', () => {
      const rooms = new RoomRegistry();
      const open = fakePeer(WebSocket.OPEN);
      const closed = fakePeer(WebSocket.CLOSED);
      rooms.join('room-1', open);
      rooms.join('room-1', closed);

      expect(rooms.broadcastAll('room-1', 'event')).toBe(1);
      expect((closed as unknown as { sent: string[] }).sent).toEqual([]);
    });

    it('never leaks events across rooms', () => {
      const rooms = new RoomRegistry();
      const mine = fakePeer();
      const theirs = fakePeer();
      rooms.join('room-1', mine);
      rooms.join('room-2', theirs);

      expect(rooms.broadcastAll('room-1', 'event')).toBe(1);
      expect((theirs as unknown as { sent: string[] }).sent).toEqual([]);
    });

    it('returns 0 for an unknown room', () => {
      const rooms = new RoomRegistry();
      expect(rooms.broadcastAll('missing', 'event')).toBe(0);
    });
  });
});

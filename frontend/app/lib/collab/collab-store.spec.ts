import { describe, it, expect } from 'vitest';
import { derivePeers } from './collab-store';

/**
 * derivePeers turns a raw Yjs Awareness snapshot into the presence roster the
 * UI renders. These tests pin the contract: local-first ordering, the neutral
 * fallback for a peer still mid-handshake, and stable ordering of remotes.
 */
describe('derivePeers', () => {
  it('tags the local client and lists it first', () => {
    const states = new Map<number, { user?: { name?: string; color?: string } }>([
      [20, { user: { name: 'Bob', color: '#6eeb83' } }],
      [10, { user: { name: 'Alice', color: '#30bced' } }],
    ]);
    const peers = derivePeers(states, 10);

    expect(peers.map((p) => p.name)).toEqual(['Alice', 'Bob']);
    expect(peers[0].isLocal).toBe(true);
    expect(peers[1].isLocal).toBe(false);
  });

  it('falls back to a neutral identity for a peer with no user field yet', () => {
    const states = new Map<number, { user?: { name?: string; color?: string } }>([
      [10, { user: { name: 'Alice', color: '#30bced' } }],
      [99, {}],
    ]);
    const peers = derivePeers(states, 10);
    const anon = peers.find((p) => p.clientId === 99)!;

    expect(anon.name).toBe('Anonymous');
    expect(anon.color).toBe('#9ac2c9');
    expect(anon.isLocal).toBe(false);
  });

  it('orders remote peers by client id', () => {
    const states = new Map<number, { user?: { name?: string; color?: string } }>([
      [30, { user: { name: 'C' } }],
      [10, { user: { name: 'A' } }],
      [20, { user: { name: 'B' } }],
    ]);
    // No local client present in the map (e.g. before local state is set).
    const peers = derivePeers(states, 999);
    expect(peers.map((p) => p.clientId)).toEqual([10, 20, 30]);
  });

  it('returns an empty roster for no states', () => {
    expect(derivePeers(new Map(), 1)).toEqual([]);
  });
});

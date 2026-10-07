/**
 * Local collaborator identity for presence (the name + colour shown on a
 * remote cursor). Kept deliberately tiny: real display names come from the
 * Cognito session when available, with a stable anonymous fallback so a user
 * without a resolved profile still gets a consistent cursor colour.
 */
export interface CollabUser {
  name: string;
  color: string;
}

// A readable, high-contrast palette. Colours are picked deterministically from
// a seed so the same client keeps the same colour across a session.
const CURSOR_COLORS = [
  '#30bced',
  '#6eeb83',
  '#ffbc42',
  '#ecd444',
  '#ee6352',
  '#9ac2c9',
  '#8acb88',
  '#1be7ff',
  '#f45d01',
  '#c47ac0',
];

/** Deterministically map a seed string to a palette colour. */
export function colorForSeed(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length];
}

/**
 * Build a presence identity. `displayName` and `id` come from the auth
 * session; when absent, fall back to an anonymous label seeded by `id` (or the
 * name) so the colour is still stable.
 */
export function makeCollabUser(opts: { displayName?: string; id?: string }): CollabUser {
  const seed = opts.id ?? opts.displayName ?? 'anonymous';
  return {
    name: opts.displayName?.trim() || 'Anonymous',
    color: colorForSeed(seed),
  };
}

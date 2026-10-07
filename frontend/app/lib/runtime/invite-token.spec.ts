import { describe, it, expect } from 'vitest';
import { parseInviteToken } from './container-runtime';

/**
 * The invite token decides whether a visitor joins someone else's live session
 * or gets a fresh sandbox of their own, so it has to be read exactly — a false
 * positive would drop a solo user into a stranger's container, and a false
 * negative would strand an invited collaborator in an empty one.
 */
describe('parseInviteToken', () => {
  it('returns null when no join parameter is present', () => {
    expect(parseInviteToken('')).toBeNull();
    expect(parseInviteToken('?foo=1')).toBeNull();
  });

  it('reads the token from ?join=', () => {
    expect(parseInviteToken('?join=abc-123')).toBe('abc-123');
  });

  it('reads the token alongside other query parameters', () => {
    expect(parseInviteToken('?foo=1&join=tok-9&bar=2')).toBe('tok-9');
  });

  it('does not match parameters that merely start with join', () => {
    expect(parseInviteToken('?joined=1&joining=yes')).toBeNull();
  });

  it('treats an empty join value as absent', () => {
    expect(parseInviteToken('?join=')).toBeNull();
  });

  it('decodes a percent-encoded token', () => {
    expect(parseInviteToken('?join=a%2Db')).toBe('a-b');
  });
});

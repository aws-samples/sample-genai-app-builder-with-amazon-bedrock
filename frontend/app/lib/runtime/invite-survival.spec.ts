import { beforeEach, describe, expect, it } from 'vitest';
import { rememberInviteToken, resolveInviteToken, forgetInviteToken } from './invite-survival';

/**
 * An invite token has to survive a full-page auth redirect.
 *
 * With an SSO provider, authentication usually happens through a silent token
 * fetch that never navigates — so the token in `?join=` is untouched. But when the
 * SSO session is missing or expired the provider navigates to its login page and
 * returns to `origin + pathname`, which drops the query string entirely. The collaborator then lands on the chat with no token, so
 * the invite is never redeemed and they get their own empty sandbox instead of the
 * session they were invited to — silently, and only for users whose SSO session had
 * lapsed, which makes it look random.
 */
/**
 * A minimal in-memory sessionStorage.
 *
 * The suite runs on node, which has no Web Storage, so without this the module
 * would take its unavailable-storage path in every test and none of the
 * remembering would be exercised.
 */
function installSessionStorage(): void {
  const entries = new Map<string, string>();

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => void entries.set(key, value),
      removeItem: (key: string) => void entries.delete(key),
      clear: () => entries.clear(),
    },
  });
}

describe('invite token survival across an auth redirect', () => {
  beforeEach(() => {
    installSessionStorage();
  });

  it('reads the token from the URL when it is present', () => {
    expect(resolveInviteToken('?join=abc-123')).toBe('abc-123');
  });

  it('recovers the token after a redirect stripped the query string', () => {
    rememberInviteToken('?join=abc-123');

    expect(resolveInviteToken('')).toBe('abc-123');
  });

  it('prefers the token in the URL over a remembered one', () => {
    rememberInviteToken('?join=stale');

    expect(resolveInviteToken('?join=fresh')).toBe('fresh');
  });

  it('remembers nothing when the URL carries no token', () => {
    rememberInviteToken('?foo=1');

    expect(resolveInviteToken('')).toBeNull();
  });

  it('forgets the token once it has been redeemed', () => {
    // Otherwise every later navigation in the tab looks like an invite, and a user
    // who has finished joining would be pushed back into someone else's session.
    rememberInviteToken('?join=abc-123');
    forgetInviteToken();

    expect(resolveInviteToken('')).toBeNull();
  });

  it('survives being called where sessionStorage is unavailable', () => {
    const original = globalThis.sessionStorage;

    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('blocked');
      },
    });

    try {
      expect(() => rememberInviteToken('?join=abc')).not.toThrow();
      expect(resolveInviteToken('?join=abc')).toBe('abc');
      expect(resolveInviteToken('')).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: original });
    }
  });
});

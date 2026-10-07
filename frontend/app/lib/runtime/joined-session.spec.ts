import { beforeEach, describe, expect, it } from 'vitest';
import { forgetJoinedSession, rememberJoinedSession, resolveJoinedSession } from './joined-session';

/**
 * A guest's membership of someone else's session has to survive a page reload.
 *
 * Everything that ties a collaborator to the session they were invited into lives
 * in page-scoped state: `window.__SANDBOX_SESSION_ID__`, the cached WebSocket
 * endpoint, and the `?join=` token — which is deliberately forgotten the moment it
 * is redeemed, so a later navigation does not drag the user back into a session
 * they had left. A reload therefore leaves the guest looking like a first-time
 * visitor, and the runtime gives them a brand-new empty sandbox of their own: from
 * the owner's side the collaborator simply vanishes.
 *
 * Remembering the session id closes that gap. It is not a capability — membership
 * is recorded server-side and re-checked on every request — so a remembered id
 * that no longer belongs to this user is refused rather than honoured.
 */
function installSessionStorage(): void {
  const entries = new Map<string, string>();

  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
      removeItem: (key: string) => entries.delete(key),
      clear: () => entries.clear(),
    },
  });
}

/** Storage that throws on every access, as hardened/private-mode browsers do. */
function installHostileStorage(): void {
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('SecurityError: storage is not available');
    },
  });
}

describe('joined-session', () => {
  beforeEach(() => {
    installSessionStorage();
  });

  it('remembers the session a guest joined, so a reload can rejoin it', () => {
    rememberJoinedSession('sess-shared');

    expect(resolveJoinedSession()).toBe('sess-shared');
  });

  it('has nothing to offer a visitor who never joined anything', () => {
    expect(resolveJoinedSession()).toBeNull();
  });

  it('forgets the session once the guest has left it', () => {
    rememberJoinedSession('sess-shared');
    forgetJoinedSession();

    expect(resolveJoinedSession()).toBeNull();
  });

  it('replaces the remembered session when a guest joins a different one', () => {
    rememberJoinedSession('sess-first');
    rememberJoinedSession('sess-second');

    expect(resolveJoinedSession()).toBe('sess-second');
  });

  it('ignores an empty id rather than remembering nothing under a real key', () => {
    rememberJoinedSession('');

    expect(resolveJoinedSession()).toBeNull();
  });

  it('degrades to forgetting rather than throwing when storage is unavailable', () => {
    installHostileStorage();

    expect(() => rememberJoinedSession('sess-shared')).not.toThrow();
    expect(resolveJoinedSession()).toBeNull();
    expect(() => forgetJoinedSession()).not.toThrow();
  });
});

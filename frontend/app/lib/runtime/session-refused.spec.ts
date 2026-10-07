import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { abandonRefusedSession } from './container-runtime';
import { sessionStatus, sessionStatusDetail } from './session-status';

/**
 * A container serves one session for its lifetime. Once it has refused this
 * session for good, the session's container is gone: the runtime must say so and
 * forget the session, so the next boot creates a fresh one instead of re-signing
 * a URL for a container that will never accept it.
 */
describe('abandonRefusedSession', () => {
  const removed: string[] = [];

  beforeEach(() => {
    removed.length = 0;
    (globalThis as any).window = {
      __SANDBOX_SESSION_ID__: 'sess-1',
      __SANDBOX_WS_ENDPOINT__: 'wss://vibe.test/ws/sess-1?Policy=p&Signature=s',
    };
    (globalThis as any).sessionStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: (key: string) => removed.push(key),
    };
  });

  afterEach(() => {
    delete (globalThis as any).window;
    delete (globalThis as any).sessionStorage;
  });

  it('forgets the session and endpoint, so the next boot starts a fresh session', () => {
    abandonRefusedSession();

    expect((globalThis as any).window.__SANDBOX_SESSION_ID__).toBeUndefined();
    expect((globalThis as any).window.__SANDBOX_WS_ENDPOINT__).toBeUndefined();
  });

  it('surfaces a clear failure to the UI', () => {
    abandonRefusedSession();

    expect(sessionStatus.get()).toBe('failed');
    expect(sessionStatusDetail.get()).toMatch(/ended/i);
  });

  it('also forgets a remembered shared session for a guest', () => {
    (globalThis as any).window.__SANDBOX_JOINED_SESSION__ = true;

    abandonRefusedSession();

    expect(removed.length).toBeGreaterThan(0);
    expect(sessionStatusDetail.get()).toMatch(/shared session/i);
  });
});

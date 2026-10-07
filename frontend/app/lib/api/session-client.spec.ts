import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logged = vi.hoisted(() => [] as string[]);

vi.mock('~/utils/logger', () => {
  const record =
    () =>
    (...args: unknown[]) =>
      logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '));

  return {
    createScopedLogger: () => ({
      trace: record(),
      debug: record(),
      info: record(),
      warn: record(),
      error: record(),
    }),
  };
});

vi.mock('./user-id', () => ({ getCurrentUserId: async () => 'user-123' }));

vi.mock('./api-client-base', () => ({
  ApiClientBase: class {
    async getHeaders() {
      return { Authorization: 'Bearer secret-bearer-token' };
    }
  },
}));

import { SessionClient } from './session-client';

/**
 * Sev2 security review: the WebSocket URL is CloudFront-signed and is the
 * credential for the sandbox socket, so it must never reach a log, and nor may
 * the Authorization header used to obtain it.
 */
describe('SessionClient logging', () => {
  const signedUrl = 'wss://vibe.example/ws/sess-1?Policy=abc&Signature=SIGNED-SECRET&Key-Pair-Id=K1';

  beforeEach(() => {
    logged.length = 0;
    vi.stubGlobal('window', { location: { origin: 'https://vibe.example' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ sessionId: 'sess-1', wsUrl: signedUrl, previewDomain: 'p' }), { status: 200 }),
      ),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not log the signed WebSocket URL or the bearer token when creating a session', async () => {
    const client = new SessionClient();

    const data = await client.createSession();

    expect(data.wsUrl).toBe(signedUrl);

    const all = logged.join('\n');
    expect(all).not.toContain('SIGNED-SECRET');
    expect(all).not.toContain('secret-bearer-token');
  });

  it('does not log the signed WebSocket URL or the invite token when joining', async () => {
    const client = new SessionClient();

    await client.joinSession('invite-token-secret');

    const all = logged.join('\n');
    expect(all).not.toContain('SIGNED-SECRET');
    expect(all).not.toContain('invite-token-secret');
  });
});

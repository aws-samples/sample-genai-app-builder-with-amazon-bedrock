import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionClient } from '~/lib/api/session-client';

/**
 * The SessionClient resolves headers through the active auth strategy; mock the
 * factory so getHeaders is a spy we can inspect for the forceRefresh flag.
 */
const getHeaders = vi.fn();

vi.mock('~/lib/auth', () => ({
  getAuthStrategy: async () => ({
    getHeaders,
    getUserId: async () => 'owner-sub',
  }),
  isInternalAuthHost: () => false,
}));

vi.mock('~/lib/api/user-id', () => ({
  getCurrentUserId: async () => 'owner-sub',
}));

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe('SessionClient auth-refresh retry', () => {
  beforeEach(() => {
    (globalThis as any).window = { location: { origin: 'https://app.example.com' } };
    getHeaders.mockReset();
    getHeaders.mockResolvedValue({ Authorization: 'Bearer token' });
  });

  afterEach(() => {
    delete (globalThis as any).window;
    vi.unstubAllGlobals();
  });

  it('retries createInvite with a force-refreshed token after a 401', async () => {
    const fetchMock = vi.fn();
    fetchMock.mockResolvedValueOnce(jsonResponse(401, { message: 'expired' }));
    fetchMock.mockResolvedValueOnce(jsonResponse(201, { token: 'invite-xyz', expiresAt: 123 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SessionClient().createInvite('session-1', 'project-1');

    expect(result.token).toBe('invite-xyz');
    expect(fetchMock).toHaveBeenCalledTimes(2);

    /**
     * The first attempt uses the cached token; the retry forces a refresh.
     */
    expect(getHeaders).toHaveBeenNthCalledWith(1, { forceRefresh: false });
    expect(getHeaders).toHaveBeenNthCalledWith(2, { forceRefresh: true });
  });

  it('does not retry createInvite when the first attempt succeeds', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(201, { token: 'invite-abc', expiresAt: 456 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await new SessionClient().createInvite('session-1');

    expect(result.token).toBe('invite-abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getHeaders).toHaveBeenCalledWith({ forceRefresh: false });
  });

  it('surfaces the error when the retry also fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { message: 'nope' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SessionClient().createInvite('session-1')).rejects.toThrow(/Failed to create invite: 403/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('propagates a thrown auth error (missing id-token) instead of masking it', async () => {
    getHeaders.mockRejectedValue(new Error('No id-token available. Please sign in again.'));

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(new SessionClient().createInvite('session-1')).rejects.toThrow(/id-token/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

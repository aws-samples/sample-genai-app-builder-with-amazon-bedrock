import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getHeaders = vi.fn();

// Mock the base client rather than the auth strategy behind it: the public
// release has a different ApiClientBase, and this spec runs in both trees.
vi.mock('../api-client-base', () => ({
  ApiClientBase: class {
    protected getHeaders(options?: { forceRefresh?: boolean }) {
      return getHeaders(options);
    }
  },
}));

const { requestEnhancement } = await import('../enhancer-client');

describe('requestEnhancement', () => {
  beforeEach(() => {
    getHeaders.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the bearer token so the gateway authorizer admits the call', async () => {
    getHeaders.mockResolvedValue({ Authorization: 'Bearer tok-1' });
    const fetchMock = vi.fn(async () => new Response('0:"x"\n', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await requestEnhancement({ message: 'hi', modelId: 'm' });

    expect(res.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/enhancer');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer tok-1', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ message: 'hi', modelId: 'm' });
  });

  it('retries once with a force-refreshed token when the authorizer rejects the first', async () => {
    getHeaders
      .mockResolvedValueOnce({ Authorization: 'Bearer stale' })
      .mockResolvedValueOnce({ Authorization: 'Bearer fresh' });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await requestEnhancement({ message: 'hi' });

    expect(res.status).toBe(200);
    expect(getHeaders).toHaveBeenLastCalledWith({ forceRefresh: true });
    const [, retryInit] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(retryInit.headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });
});

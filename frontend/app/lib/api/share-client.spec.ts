import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShareClient } from './share-client';

describe('ShareClient.uploadFile', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the Content-Type S3 signed the URL for', async () => {
    /**
     * A fetch PUT with a Uint8Array body carries no Content-Type header, so S3
     * falls back to binary/octet-stream and browsers download the shared page
     * instead of rendering it. The header must be set explicitly.
     */
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ShareClient().uploadFile('https://s3/presigned', new Uint8Array([1]), 'text/html');

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toMatchObject({ 'Content-Type': 'text/html' });
  });

  it('omits the header when no content type is known', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await new ShareClient().uploadFile('https://s3/presigned', new Uint8Array([1]));

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.headers).toBeUndefined();
  });

  it('surfaces a failed upload status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 403 })),
    );

    await expect(
      new ShareClient().uploadFile('https://s3/presigned', new Uint8Array([1]), 'text/html'),
    ).rejects.toThrow('403');
  });
});

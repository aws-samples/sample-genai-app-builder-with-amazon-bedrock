import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrandTemplatesClient } from '../client';

// Mock Amplify session so ApiClientBase returns a deterministic token.
vi.mock('aws-amplify/auth', () => ({
  fetchAuthSession: async () => ({
    tokens: { idToken: { toString: () => 'test-id-token' } },
  }),
}));

const REST_URL = 'https://rest.example.com/api';

function setEnv() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (window as any).ENV = { API_GATEWAY_REST_URL: REST_URL };
}

function mockFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return handler(url, init ?? {});
  });
  globalThis.fetch = fetchMock as any;
  return fetchMock;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('BrandTemplatesClient', () => {
  beforeEach(() => {
    setEnv();
    vi.clearAllMocks();
  });

  it('listSkills returns an empty list when the server reports none', async () => {
    mockFetch(async () => jsonResponse({ skills: [] }));
    const client = new BrandTemplatesClient();
    expect(await client.listSkills()).toEqual([]);
  });

  it('listSkills passes the bearer token and targets the brand-templates path', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ skills: [{ skillId: 's1', name: 'One', status: 'ready' }] }),
    );
    const client = new BrandTemplatesClient();
    await client.listSkills();
    const [calledUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(`${REST_URL}/v1/brand-templates`);
    expect((init.headers as any).Authorization).toBe('Bearer test-id-token');
  });

  it('getSkill URL-encodes the id', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ skillId: 'abc def' }));
    const client = new BrandTemplatesClient();
    await client.getSkill('abc def');
    expect(fetchMock.mock.calls[0][0]).toBe(`${REST_URL}/v1/brand-templates/abc%20def`);
  });

  it('patchSkill issues PATCH with the metadata body', async () => {
    const fetchMock = mockFetch(async () => jsonResponse({ name: 'Renamed' }));
    const client = new BrandTemplatesClient();
    await client.patchSkill('s1', { name: 'Renamed', tags: ['a'] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${REST_URL}/v1/brand-templates/s1`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Renamed', tags: ['a'] });
  });

  it('deleteSkill issues DELETE', async () => {
    const fetchMock = mockFetch(async () => new Response(null, { status: 200 }));
    const client = new BrandTemplatesClient();
    await client.deleteSkill('s1');
    expect(fetchMock.mock.calls[0][1]!.method).toBe('DELETE');
  });

  it('createFromUrl posts source=url', async () => {
    const fetchMock = mockFetch(async () =>
      jsonResponse({ skillId: 'sk', jobId: 'jb', status: 'processing' }, 202),
    );
    const client = new BrandTemplatesClient();
    const response = await client.createFromUrl({ name: 'Linear', url: 'https://linear.app' });
    expect(response.status).toBe('processing');
    const body = JSON.parse(fetchMock.mock.calls[0][1]!.body as string);
    expect(body).toEqual({ name: 'Linear', source: 'url', url: 'https://linear.app' });
  });

  it('createFromImages uploads every file to its presigned URL, then posts create', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    mockFetch(async (url, init) => {
      calls.push({ url, method: init.method ?? 'GET' });
      if (url.endsWith('/upload-urls')) {
        return jsonResponse({
          jobId: '22222222-2222-4222-8222-222222222222',
          uploads: [
            { url: 'https://s3.example/upload-0', s3Key: 'uploads/u/j/input-0.png' },
            { url: 'https://s3.example/upload-1', s3Key: 'uploads/u/j/input-1.png' },
          ],
        });
      }
      if (url.startsWith('https://s3.example/')) {
        return new Response(null, { status: 200 });
      }
      if (url === `${REST_URL}/v1/brand-templates`) {
        return jsonResponse({ skillId: 'sk', jobId: 'jb', status: 'processing' }, 202);
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const file0 = new File(['x'], 'a.png', { type: 'image/png' });
    const file1 = new File(['y'], 'b.png', { type: 'image/png' });
    const client = new BrandTemplatesClient();
    const response = await client.createFromImages({ name: 'My skill', files: [file0, file1] });

    expect(response.skillId).toBe('sk');
    const orderedUrls = calls.map((c) => c.url);
    expect(orderedUrls[0]).toBe(`${REST_URL}/v1/brand-templates/upload-urls`);
    expect(orderedUrls).toContain('https://s3.example/upload-0');
    expect(orderedUrls).toContain('https://s3.example/upload-1');
    expect(orderedUrls[orderedUrls.length - 1]).toBe(`${REST_URL}/v1/brand-templates`);
  });

  it('createFromImages rejects outside the 1..5 file range', async () => {
    mockFetch(async () => jsonResponse({}));
    const client = new BrandTemplatesClient();
    await expect(client.createFromImages({ name: 'n', files: [] })).rejects.toThrow(/1 to 5/);
    const many = Array.from({ length: 6 }, (_, i) =>
      new File(['x'], `f${i}.png`, { type: 'image/png' }),
    );
    await expect(client.createFromImages({ name: 'n', files: many })).rejects.toThrow(/1 to 5/);
  });

  it('pollUntilDone resolves when status flips to ready', async () => {
    let calls = 0;
    mockFetch(async (url) => {
      if (url.includes('/status/')) {
        calls += 1;
        if (calls < 2) {
          return jsonResponse({ status: 'processing', progress: { stage: 'x', message: 'y' } });
        }
        return jsonResponse({ status: 'ready', skillId: 'sk' });
      }
      if (url.endsWith('/sk')) {
        return jsonResponse({ skillId: 'sk', name: 'Done' });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    const client = new BrandTemplatesClient();
    const result = await client.pollUntilDone('jb', { intervalMs: 1, timeoutMs: 1000 });
    expect(result.skillId).toBe('sk');
  });

  it('pollUntilDone rejects when the server reports failure', async () => {
    mockFetch(async () =>
      jsonResponse({
        status: 'failed',
        error: { code: 'extraction_error', message: 'nope' },
      }),
    );
    const client = new BrandTemplatesClient();
    await expect(client.pollUntilDone('jb', { intervalMs: 1 })).rejects.toThrow(/nope/);
  });

  it('surfaces 400 error bodies from the server', async () => {
    mockFetch(async () => jsonResponse({ error: 'Only name, description, and tags may be edited.' }, 400));
    const client = new BrandTemplatesClient();
    await expect(
      client.createFromUrl({ name: 'n', url: 'http://example.com' }),
    ).rejects.toThrow(/Only name/);
  });
});

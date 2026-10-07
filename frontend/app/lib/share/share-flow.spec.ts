import { describe, expect, it, vi } from 'vitest';
import { publishShare, SHARE_BUILD_COMMAND, type ShareFlowDeps, type DistFile } from './share-flow';

function b64(text: string): string {
  return btoa(text);
}

function deps(overrides: Partial<ShareFlowDeps> = {}): ShareFlowDeps {
  return {
    runBuild: vi.fn(async () => ({ exitCode: 0 })),
    collectDist: vi.fn(
      async (): Promise<DistFile[]> => [{ path: 'dist/index.html', content: b64('<html></html>'), isBinary: false }],
    ),
    createShare: vi.fn(async (_title: string, files: string[]) => ({
      shareId: 'share-1',
      fileMap: files.map((file) => ({ file, url: `https://s3/${file}`, contentType: 'text/html' })),
    })),
    uploadFile: vi.fn(async () => {}),
    confirmShare: vi.fn(async () => ({ url: 'https://vibe/shared/share-1/' })),
    ...overrides,
  };
}

describe('publishShare', () => {
  it('builds with a relative base so assets do not point at the sandbox proxy', async () => {
    /**
     * The regression: the sandbox agent patches vite.config with
     * base '/sandbox-preview/{sessionId}/' so the live preview routes through
     * CloudFront. A share built with that config emits
     * <script src="/sandbox-preview/{sessionId}/assets/…"> — dead the moment
     * the session ends, and never valid under /shared/{id}/. The share build
     * must override it from the CLI.
     */
    const runBuild = vi.fn(async () => ({ exitCode: 0 }));

    await publishShare(deps({ runBuild }));

    expect(runBuild).toHaveBeenCalledWith(SHARE_BUILD_COMMAND);
    expect(SHARE_BUILD_COMMAND).toContain('--base=./');
  });

  it('uploads each file with the content type the server assigned', async () => {
    /**
     * Without this, the browser PUT carries no Content-Type, S3 stores
     * binary/octet-stream, and the shared link downloads instead of rendering.
     */
    const uploadFile = vi.fn<ShareFlowDeps['uploadFile']>(async () => {});
    const createShare = vi.fn(async (_title: string, files: string[]) => ({
      shareId: 'share-1',
      fileMap: [{ file: files[0], url: 'https://s3/index.html', contentType: 'text/html' }],
    }));

    await publishShare(deps({ uploadFile, createShare }));

    expect(uploadFile).toHaveBeenCalledWith('https://s3/index.html', expect.any(Uint8Array), 'text/html');
  });

  it('decodes base64 text content before uploading', async () => {
    const uploadFile = vi.fn<ShareFlowDeps['uploadFile']>(async () => {});

    await publishShare(
      deps({
        collectDist: async () => [{ path: 'dist/index.html', content: b64('<html>hi</html>'), isBinary: false }],
        uploadFile,
      }),
    );

    const [, bytes] = uploadFile.mock.calls[0];
    expect(new TextDecoder().decode(bytes as Uint8Array)).toBe('<html>hi</html>');
  });

  it('decodes base64 binary content byte-for-byte', async () => {
    const uploadFile = vi.fn<ShareFlowDeps['uploadFile']>(async () => {});
    const raw = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const encoded = btoa(String.fromCharCode(...raw));

    await publishShare(
      deps({
        collectDist: async () => [{ path: 'dist/logo.png', content: encoded, isBinary: true }],
        createShare: async (_t, files) => ({
          shareId: 'share-1',
          fileMap: [{ file: files[0], url: 'https://s3/logo.png', contentType: 'image/png' }],
        }),
        uploadFile,
      }),
    );

    expect(Array.from(uploadFile.mock.calls[0][1] as Uint8Array)).toEqual(Array.from(raw));
  });

  it('returns the confirmed share URL', async () => {
    const confirmShare = vi.fn(async () => ({ url: 'https://vibe/shared/share-1/' }));

    await expect(publishShare(deps({ confirmShare }))).resolves.toBe('https://vibe/shared/share-1/');
    expect(confirmShare).toHaveBeenCalledWith('share-1', 'Shared Project');
  });

  it('fails on a non-zero build exit with the stderr in the message', async () => {
    const runBuild = vi.fn(async () => ({ exitCode: 1, stderr: 'vite: not found' }));

    await expect(publishShare(deps({ runBuild }))).rejects.toThrow(/exit code 1.*vite: not found/s);
  });

  it('fails when the build produced no dist files', async () => {
    await expect(publishShare(deps({ collectDist: async () => [] }))).rejects.toThrow(/no output files/i);
  });

  it('reports the publishing stage after the build finishes', async () => {
    const stages: string[] = [];

    await publishShare(deps({ onProgress: (stage) => stages.push(stage) }));

    expect(stages).toEqual(['publishing']);
  });
});

/**
 * Publishing a project snapshot to a shareable /shared/{id}/ URL.
 *
 * Two production failures shaped this module, both of which made a share link
 * download a file (or load a blank page) instead of showing the site:
 *
 * 1. The sandbox agent patches vite.config with
 *    `base: '/sandbox-preview/{sessionId}/'` so the live preview routes through
 *    CloudFront to the container. A share built with that config bakes the
 *    session's proxy path into every asset URL — dead as soon as the session
 *    ends, and never valid under /shared/{id}/. The share build overrides the
 *    base from the CLI with a relative one.
 *
 * 2. A browser `fetch` PUT with a Uint8Array body sends no Content-Type, so S3
 *    stored every object as binary/octet-stream and browsers downloaded
 *    index.html rather than rendering it. The share Lambda now returns the
 *    Content-Type it signed each upload URL for, and every upload echoes it.
 */

/**
 * `--base=./` reaches vite through npm's argument passthrough and overrides the
 * sandbox-preview base the agent patched into vite.config. Relative asset URLs
 * work at whatever path the snapshot is served from.
 */
export const SHARE_BUILD_COMMAND = 'npm run build -- --base=./';

export interface DistFile {
  path: string;

  /** Base64-encoded by the sidecar's fs:sync (text and binary alike). */
  content: string;
  isBinary?: boolean;
}

export interface ShareFlowDeps {
  /** Run a shell command in the sandbox; resolves with its exit code. */
  runBuild: (command: string) => Promise<{ exitCode: number; stderr?: string }>;

  /** Collect the built site from the sandbox's dist/ folder. */
  collectDist: () => Promise<DistFile[]>;

  createShare: (
    title: string,
    files: string[],
  ) => Promise<{ shareId: string; fileMap: { file: string; url: string; contentType?: string }[] }>;

  uploadFile: (url: string, content: Uint8Array, contentType?: string) => Promise<void>;

  confirmShare: (shareId: string, title: string) => Promise<{ url: string }>;

  /** The build is the long half; this marks the hand-off to uploading. */
  onProgress?: (stage: 'publishing') => void;
}

const SHARE_TITLE = 'Shared Project';

function decodeContent(file: DistFile): Uint8Array {
  if (file.isBinary) {
    const binaryStr = atob(file.content);
    const bytes = new Uint8Array(binaryStr.length);

    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }

    return bytes;
  }

  // text content is base64 too, but tolerate a sidecar that sent it raw
  let text: string;

  try {
    text = atob(file.content);
  } catch {
    text = file.content;
  }

  return new TextEncoder().encode(text);
}

/** Build, upload, and confirm a share. Resolves with the public URL. */
export async function publishShare(deps: ShareFlowDeps): Promise<string> {
  const buildResult = await deps.runBuild(SHARE_BUILD_COMMAND);

  if (buildResult.exitCode !== 0) {
    throw new Error(`Build failed (exit code ${buildResult.exitCode}): ${buildResult.stderr || ''}`);
  }

  deps.onProgress?.('publishing');

  const distFiles = (await deps.collectDist()).filter((f) => f.content);

  if (distFiles.length === 0) {
    throw new Error('Build produced no output files in dist/');
  }

  const { shareId, fileMap } = await deps.createShare(
    SHARE_TITLE,
    distFiles.map((f) => f.path),
  );

  await Promise.all(
    fileMap.map(async ({ file, url, contentType }) => {
      const distFile = distFiles.find((f) => f.path === file);

      if (!distFile) {
        return;
      }

      await deps.uploadFile(url, decodeContent(distFile), contentType);
    }),
  );

  const { url } = await deps.confirmShare(shareId, SHARE_TITLE);

  return url;
}

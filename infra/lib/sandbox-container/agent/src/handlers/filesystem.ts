import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import fg from 'fast-glob';
import {
  createResponse,
  type WSMessage,
  type WSResponse,
  type FsWritePayload,
  type FsReadPayload,
  type FsMkdirPayload,
  type FsSyncPayload,
  type FsSyncFile,
} from '../protocol.js';

const WORKDIR = process.env.WORKDIR ?? '/home/sandbox/project';

// Binary file extensions that should be base64-encoded
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.7z',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm',
  '.wasm', '.bin', '.exe', '.dll', '.so', '.dylib',
]);

/**
 * Resolve a user-supplied path safely within WORKDIR.
 * Throws if the resolved path escapes WORKDIR.
 */
export function resolveSafePath(userPath: string, workdir: string = WORKDIR): string {
  // Normalise the user path – join it to workdir so relative paths anchor there
  const resolved = path.resolve(workdir, userPath);
  const normalised = path.normalize(resolved);

  // The resolved path must be equal to or a child of workdir
  const workdirWithSep = workdir.endsWith(path.sep) ? workdir : workdir + path.sep;
  if (normalised !== workdir && !normalised.startsWith(workdirWithSep)) {
    throw new Error(`Path traversal denied: "${userPath}" resolves outside workdir`);
  }

  return normalised;
}

/**
 * Determine whether a file path is likely binary based on its extension.
 */
function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Handle fs:write:req – write content to a file.
 */
export async function handleFsWrite(
  msg: WSMessage,
  workdir: string = WORKDIR
): Promise<WSResponse> {
  const payload = msg.payload as unknown as FsWritePayload;

  if (!payload.path) {
    throw new Error('Missing required field: path');
  }
  if (payload.content === undefined || payload.content === null) {
    throw new Error('Missing required field: content');
  }

  const safePath = resolveSafePath(payload.path, workdir);

  // Ensure parent directory exists
  await fs.mkdir(path.dirname(safePath), { recursive: true });

  const encoding = payload.encoding ?? 'utf-8';
  if (encoding === 'base64') {
    const buffer = Buffer.from(payload.content, 'base64');
    await fs.writeFile(safePath, buffer);
  } else {
    await fs.writeFile(safePath, payload.content, encoding as BufferEncoding);
  }

  return createResponse(msg.id, 'fs:write:res', { success: true });
}

/**
 * Handle fs:read:req – read content from a file.
 */
export async function handleFsRead(
  msg: WSMessage,
  workdir: string = WORKDIR
): Promise<WSResponse> {
  const payload = msg.payload as unknown as FsReadPayload;

  if (!payload.path) {
    throw new Error('Missing required field: path');
  }

  const safePath = resolveSafePath(payload.path, workdir);
  const binary = isBinaryPath(safePath);

  if (binary) {
    const buffer = await fs.readFile(safePath);
    return createResponse(msg.id, 'fs:read:res', {
      content: buffer.toString('base64'),
      isBinary: true,
      encoding: 'base64',
    });
  }

  const encoding = (payload.encoding ?? 'utf-8') as BufferEncoding;
  const content = await fs.readFile(safePath, encoding);
  return createResponse(msg.id, 'fs:read:res', {
    content,
    isBinary: false,
    encoding,
  });
}

/**
 * Handle fs:mkdir:req – create a directory (recursively).
 */
export async function handleFsMkdir(
  msg: WSMessage,
  workdir: string = WORKDIR
): Promise<WSResponse> {
  const payload = msg.payload as unknown as FsMkdirPayload;

  if (!payload.path) {
    throw new Error('Missing required field: path');
  }

  const safePath = resolveSafePath(payload.path, workdir);
  await fs.mkdir(safePath, { recursive: true });

  return createResponse(msg.id, 'fs:mkdir:res', { success: true });
}

/**
 * Handle fs:sync:req – list files in the project directory.
 */
export async function handleFsSync(
  msg: WSMessage,
  workdir: string = WORKDIR
): Promise<WSResponse> {
  const payload = msg.payload as unknown as FsSyncPayload;

  const include = payload.include ?? ['**/*'];
  const exclude = payload.exclude ?? ['**/node_modules/**', '**/.git/**'];
  const includeContent = payload.includeContent ?? false;

  const entries = await fg(include, {
    cwd: workdir,
    ignore: exclude,
    dot: true,
    onlyFiles: false,
    markDirectories: true,
    stats: false,
  });

  const files: FsSyncFile[] = [];

  for (const entry of entries) {
    const isDir = entry.endsWith('/');
    const relativePath = isDir ? entry.slice(0, -1) : entry;
    const absolutePath = path.join(workdir, relativePath);

    if (isDir) {
      files.push({ path: relativePath, type: 'directory' });
    } else {
      const file: FsSyncFile = { path: relativePath, type: 'file' };

      if (includeContent) {
        const binary = isBinaryPath(absolutePath);
        file.isBinary = binary;

        if (binary) {
          const buffer = await fs.readFile(absolutePath);
          file.content = buffer.toString('base64');
        } else {
          file.content = await fs.readFile(absolutePath, 'utf-8');
        }
      }

      files.push(file);
    }
  }

  return createResponse(msg.id, 'fs:sync:res', { files });
}

/**
 * Route an incoming fs:* message to the correct handler.
 */
export async function handleFilesystem(
  msg: WSMessage,
  workdir: string = WORKDIR
): Promise<WSResponse> {
  const action = msg.type.split(':')[1];

  switch (action) {
    case 'write':
      return handleFsWrite(msg, workdir);
    case 'read':
      return handleFsRead(msg, workdir);
    case 'mkdir':
      return handleFsMkdir(msg, workdir);
    case 'sync':
      return handleFsSync(msg, workdir);
    default:
      throw new Error(`Unknown fs action: ${action}`);
  }
}

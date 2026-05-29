import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  handleFsWrite,
  handleFsRead,
  handleFsMkdir,
  handleFsSync,
  resolveSafePath,
} from '../src/handlers/filesystem.js';
import type { WSMessage } from '../src/protocol.js';

function makeMsg(type: string, payload: Record<string, unknown>): WSMessage {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

describe('filesystem handler', () => {
  let workdir: string;

  beforeEach(async () => {
    workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'sandbox-fs-test-'));
  });

  afterEach(async () => {
    await fs.rm(workdir, { recursive: true, force: true });
  });

  // ── resolveSafePath ──────────────────────────────────────────

  describe('resolveSafePath', () => {
    it('resolves a simple relative path within workdir', () => {
      const result = resolveSafePath('hello.txt', workdir);
      expect(result).toBe(path.join(workdir, 'hello.txt'));
    });

    it('resolves a nested relative path within workdir', () => {
      const result = resolveSafePath('src/index.ts', workdir);
      expect(result).toBe(path.join(workdir, 'src', 'index.ts'));
    });

    it('rejects path traversal with ../', () => {
      expect(() => resolveSafePath('../etc/passwd', workdir)).toThrow('Path traversal denied');
    });

    it('rejects path traversal with absolute path outside workdir', () => {
      expect(() => resolveSafePath('/etc/passwd', workdir)).toThrow('Path traversal denied');
    });

    it('rejects sneaky path traversal', () => {
      expect(() => resolveSafePath('subdir/../../etc/passwd', workdir)).toThrow(
        'Path traversal denied'
      );
    });

    it('allows the workdir itself', () => {
      const result = resolveSafePath('.', workdir);
      expect(result).toBe(workdir);
    });
  });

  // ── fs:write ────────────────────────────────────────────────

  describe('fs:write', () => {
    it('writes a text file', async () => {
      const msg = makeMsg('fs:write:req', { path: 'test.txt', content: 'hello world' });
      const res = await handleFsWrite(msg, workdir);

      expect(res.payload.success).toBe(true);
      expect(res.type).toBe('fs:write:res');
      expect(res.requestId).toBe(msg.id);

      const content = await fs.readFile(path.join(workdir, 'test.txt'), 'utf-8');
      expect(content).toBe('hello world');
    });

    it('writes a file in a nested directory (auto-creates parents)', async () => {
      const msg = makeMsg('fs:write:req', {
        path: 'deep/nested/dir/file.txt',
        content: 'nested content',
      });
      const res = await handleFsWrite(msg, workdir);
      expect(res.payload.success).toBe(true);

      const content = await fs.readFile(path.join(workdir, 'deep/nested/dir/file.txt'), 'utf-8');
      expect(content).toBe('nested content');
    });

    it('writes a base64-encoded binary file', async () => {
      const original = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
      const msg = makeMsg('fs:write:req', {
        path: 'image.png',
        content: original.toString('base64'),
        encoding: 'base64',
      });
      const res = await handleFsWrite(msg, workdir);
      expect(res.payload.success).toBe(true);

      const buffer = await fs.readFile(path.join(workdir, 'image.png'));
      expect(buffer).toEqual(original);
    });

    it('rejects path traversal', async () => {
      const msg = makeMsg('fs:write:req', { path: '../evil.txt', content: 'bad' });
      await expect(handleFsWrite(msg, workdir)).rejects.toThrow('Path traversal denied');
    });

    it('rejects missing path', async () => {
      const msg = makeMsg('fs:write:req', { content: 'no path' });
      await expect(handleFsWrite(msg, workdir)).rejects.toThrow('Missing required field: path');
    });

    it('rejects missing content', async () => {
      const msg = makeMsg('fs:write:req', { path: 'test.txt' });
      await expect(handleFsWrite(msg, workdir)).rejects.toThrow('Missing required field: content');
    });
  });

  // ── fs:read ─────────────────────────────────────────────────

  describe('fs:read', () => {
    it('reads a text file', async () => {
      await fs.writeFile(path.join(workdir, 'read-me.txt'), 'file content');
      const msg = makeMsg('fs:read:req', { path: 'read-me.txt' });
      const res = await handleFsRead(msg, workdir);

      expect(res.type).toBe('fs:read:res');
      expect(res.payload.content).toBe('file content');
      expect(res.payload.isBinary).toBe(false);
      expect(res.payload.encoding).toBe('utf-8');
    });

    it('reads a binary file as base64', async () => {
      const data = Buffer.from([0x00, 0xff, 0x42, 0x43]);
      await fs.writeFile(path.join(workdir, 'data.bin'), data);
      const msg = makeMsg('fs:read:req', { path: 'data.bin' });
      const res = await handleFsRead(msg, workdir);

      expect(res.payload.isBinary).toBe(true);
      expect(res.payload.encoding).toBe('base64');
      const decoded = Buffer.from(res.payload.content as string, 'base64');
      expect(decoded).toEqual(data);
    });

    it('throws for non-existent file', async () => {
      const msg = makeMsg('fs:read:req', { path: 'nope.txt' });
      await expect(handleFsRead(msg, workdir)).rejects.toThrow();
    });

    it('rejects path traversal', async () => {
      const msg = makeMsg('fs:read:req', { path: '../../etc/hosts' });
      await expect(handleFsRead(msg, workdir)).rejects.toThrow('Path traversal denied');
    });
  });

  // ── fs:mkdir ────────────────────────────────────────────────

  describe('fs:mkdir', () => {
    it('creates a directory', async () => {
      const msg = makeMsg('fs:mkdir:req', { path: 'new-dir' });
      const res = await handleFsMkdir(msg, workdir);

      expect(res.payload.success).toBe(true);
      const stat = await fs.stat(path.join(workdir, 'new-dir'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('creates nested directories', async () => {
      const msg = makeMsg('fs:mkdir:req', { path: 'a/b/c' });
      const res = await handleFsMkdir(msg, workdir);

      expect(res.payload.success).toBe(true);
      const stat = await fs.stat(path.join(workdir, 'a/b/c'));
      expect(stat.isDirectory()).toBe(true);
    });

    it('is idempotent on existing directory', async () => {
      await fs.mkdir(path.join(workdir, 'existing'));
      const msg = makeMsg('fs:mkdir:req', { path: 'existing' });
      const res = await handleFsMkdir(msg, workdir);
      expect(res.payload.success).toBe(true);
    });
  });

  // ── fs:sync ─────────────────────────────────────────────────

  describe('fs:sync', () => {
    it('lists files in the workdir', async () => {
      await fs.writeFile(path.join(workdir, 'a.txt'), 'a');
      await fs.writeFile(path.join(workdir, 'b.txt'), 'b');

      const msg = makeMsg('fs:sync:req', {});
      const res = await handleFsSync(msg, workdir);

      expect(res.type).toBe('fs:sync:res');
      const files = res.payload.files as Array<{ path: string; type: string }>;
      const filePaths = files.map((f) => f.path).sort();
      expect(filePaths).toContain('a.txt');
      expect(filePaths).toContain('b.txt');
    });

    it('includes content when requested', async () => {
      await fs.writeFile(path.join(workdir, 'content.txt'), 'my content');

      const msg = makeMsg('fs:sync:req', { includeContent: true });
      const res = await handleFsSync(msg, workdir);

      const files = res.payload.files as Array<{ path: string; content?: string }>;
      const f = files.find((f) => f.path === 'content.txt');
      expect(f).toBeDefined();
      expect(f!.content).toBe('my content');
    });

    it('excludes node_modules by default', async () => {
      await fs.mkdir(path.join(workdir, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(workdir, 'node_modules', 'pkg.js'), '');
      await fs.writeFile(path.join(workdir, 'index.js'), '');

      const msg = makeMsg('fs:sync:req', {});
      const res = await handleFsSync(msg, workdir);

      const files = res.payload.files as Array<{ path: string }>;
      const paths = files.map((f) => f.path);
      expect(paths).toContain('index.js');
      expect(paths.some((p) => p.includes('node_modules'))).toBe(false);
    });
  });
});

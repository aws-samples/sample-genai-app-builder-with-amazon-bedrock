import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createResponse,
  createEvent,
  type WSMessage,
  type WSResponse,
  type WSEvent,
  type ShellExecPayload,
  type ShellKillPayload,
} from '../protocol.js';

function getWorkdir(): string {
  return process.env.WORKDIR ?? '/home/sandbox/project';
}

/**
 * Kill a process and its entire process group (spawned with detached: true).
 * This ensures grandchild processes (e.g. Vite, esbuild) are also terminated.
 */
function killProcessGroup(child: ChildProcess): void {
  try {
    if (child.pid) {
      // Kill the entire process group via negative PID
      process.kill(-child.pid, 'SIGKILL');
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    // Process may already be dead
  }
}

/**
 * Patch vite.config.* to work behind the CloudFront → ALB reverse proxy.
 *
 * Two things are needed:
 *  1. allowedHosts: true — Vite blocks requests whose Host header doesn't
 *     match (CloudFront/ALB send their own hostname).
 *  2. base: '/sandbox-preview/' — Vite's asset URLs must include the
 *     CloudFront path prefix so sub-resource requests (JS, CSS, HMR) route
 *     back through the /sandbox-preview* behavior to the ALB, not to the
 *     frontend Lambda.
 *
 * This is a safety net — the LLM prompt also asks for these settings but
 * isn't guaranteed to produce them every time.
 */
function patchViteConfig(cwd: string): void {
  const PREVIEW_BASE = process.env.PREVIEW_BASE_PATH || '/sandbox-preview/';

  try {
    const files = readdirSync(cwd);
    const viteConfig = files.find((f) => /^vite\.config\.(js|ts|mjs|mts)$/.test(f));
    if (!viteConfig) return;

    const filePath = join(cwd, viteConfig);
    let content = readFileSync(filePath, 'utf-8');
    let patched = false;

    // --- Inject allowedHosts into server block ---
    if (!content.includes('allowedHosts')) {
      if (/server\s*:\s*\{/.test(content)) {
        content = content.replace(
          /server\s*:\s*\{/,
          'server: { allowedHosts: true,'
        );
        patched = true;
      } else if (/defineConfig\s*\(\s*\{/.test(content)) {
        content = content.replace(
          /defineConfig\s*\(\s*\{/,
          'defineConfig({ server: { allowedHosts: true },'
        );
        patched = true;
      } else if (/export\s+default\s*\{/.test(content)) {
        content = content.replace(
          /export\s+default\s*\{/,
          'export default { server: { allowedHosts: true },'
        );
        patched = true;
      }
    }

    // --- Inject host: "0.0.0.0" so Vite binds to all interfaces (ALB needs this) ---
    if (!content.includes('host:') && !content.includes("host :")) {
      if (/server\s*:\s*\{/.test(content)) {
        content = content.replace(
          /server\s*:\s*\{/,
          'server: { host: "0.0.0.0",'
        );
        patched = true;
      } else if (/defineConfig\s*\(\s*\{/.test(content)) {
        content = content.replace(
          /defineConfig\s*\(\s*\{/,
          'defineConfig({ server: { host: "0.0.0.0" },'
        );
        patched = true;
      } else if (/export\s+default\s*\{/.test(content)) {
        content = content.replace(
          /export\s+default\s*\{/,
          'export default { server: { host: "0.0.0.0" },'
        );
        patched = true;
      }
    }

    // --- Inject or replace base path for CloudFront routing ---
    // Replace existing base: value (e.g. stale path from a previous session)
    if (content.includes('base:') || content.includes('base :')) {
      const oldContent = content;
      content = content.replace(/base\s*:\s*['"][^'"]*['"]/, `base: '${PREVIEW_BASE}'`);
      if (content !== oldContent) {
        patched = true;
      }
    } else if (!content.includes('base:') && !content.includes('base :')) {
      if (/defineConfig\s*\(\s*\{/.test(content)) {
        content = content.replace(
          /defineConfig\s*\(\s*\{/,
          `defineConfig({ base: '${PREVIEW_BASE}',`
        );
        patched = true;
      } else if (/export\s+default\s*\{/.test(content)) {
        content = content.replace(
          /export\s+default\s*\{/,
          `export default { base: '${PREVIEW_BASE}',`
        );
        patched = true;
      }
    }

    if (patched) {
      writeFileSync(filePath, content);
      console.log(`[shell] Patched ${viteConfig} for reverse-proxy (host + allowedHosts + base)`);
    } else {
      console.log(`[shell] No vite config changes needed for ${viteConfig}`);
    }
  } catch (err) {
    console.warn(`[shell] Failed to patch vite config:`, err);
  }
}

export type EventEmitter = (event: WSEvent) => void;

/**
 * Manages one-shot shell command execution.
 */
export class ShellManager {
  private processes: Map<number, ChildProcess> = new Map();
  private emit: EventEmitter;

  constructor(emit: EventEmitter) {
    this.emit = emit;
  }

  /**
   * Update the event emitter (e.g. after WebSocket reconnect).
   * Preserves existing tracked processes.
   */
  setEmitter(newEmit: EventEmitter): void {
    this.emit = newEmit;
  }

  /**
   * Handle shell:exec:req – run a command and collect output.
   */
  handleExec(msg: WSMessage): Promise<WSResponse> {
    const payload = msg.payload as unknown as ShellExecPayload;

    if (!payload.command) {
      return Promise.reject(new Error('Missing required field: command'));
    }

    return new Promise<WSResponse>((resolve, reject) => {
      const cwd = payload.cwd ?? getWorkdir();
      // Strip NODE_ENV=production so user npm install includes devDependencies
      const { NODE_ENV: _omit, ...baseEnv } = process.env;
      const env = { ...baseEnv, ...(payload.env ?? {}) } as Record<string, string>;
      const timeout = payload.timeout ?? 0;

      // Before running dev server commands, patch vite.config for reverse-proxy
      let command = payload.command;
      const isDevServer = /\b(npm run dev|npx vite|vite)\b/.test(command);
      if (isDevServer) {
        // Kill any existing dev server on common ports before starting a new one
        try {
          execSync('lsof -t -i:5173 -i:3000 -i:3001 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true', { stdio: 'ignore' });
        } catch {
          // Best effort
        }
        patchViteConfig(cwd);
        // Inject --host 0.0.0.0 so Vite binds on all interfaces (ALB needs this).
        // Vite doesn't read the HOST env var, so we inject via CLI flag.
        command = command
          .replace(/\bnpm run dev\b(?!\s+--\s+--host)/, 'npm run dev -- --host 0.0.0.0')
          .replace(/\bnpx vite\b(?!\s+--host)/, 'npx vite --host 0.0.0.0')
          .replace(/(?<!\w)vite\b(?!\s+--host)(?!\.config)/, 'vite --host 0.0.0.0');
        console.log(`[shell] Rewritten dev command: ${command}`);
      }

      const child = spawn('/bin/sh', ['-c', command], {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // Own process group so we can kill the entire tree
      });

      const pid = child.pid ?? -1;
      this.processes.set(pid, child);

      let stdout = '';
      let stderr = '';
      let killed = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

      // Set up timeout if requested
      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          killed = true;
          killProcessGroup(child);
        }, timeout);
      }

      child.stdout?.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf-8');
        stdout += data;
        this.emit(
          createEvent('shell:output:event', {
            processId: pid,
            stream: 'stdout',
            data,
          })
        );
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        const data = chunk.toString('utf-8');
        stderr += data;
        this.emit(
          createEvent('shell:output:event', {
            processId: pid,
            stream: 'stderr',
            data,
          })
        );
      });

      child.on('close', (exitCode: number | null) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.processes.delete(pid);

        resolve(
          createResponse(msg.id, 'shell:exec:res', {
            exitCode: killed ? -1 : (exitCode ?? -1),
            stdout,
            stderr,
            processId: pid,
          })
        );
      });

      child.on('error', (err: Error) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.processes.delete(pid);
        reject(err);
      });
    });
  }

  /**
   * Handle shell:kill:req – kill a running process.
   */
  handleKill(msg: WSMessage): WSResponse {
    const payload = msg.payload as unknown as ShellKillPayload;

    if (payload.processId === undefined) {
      throw new Error('Missing required field: processId');
    }

    const child = this.processes.get(payload.processId);
    if (!child) {
      throw new Error(`Process not found: ${payload.processId}`);
    }

    killProcessGroup(child);
    this.processes.delete(payload.processId);

    return createResponse(msg.id, 'shell:kill:res', { success: true });
  }

  /**
   * Kill all running processes. Called on WebSocket disconnect.
   */
  destroyAll(): void {
    for (const [pid, child] of this.processes) {
      killProcessGroup(child);
      this.processes.delete(pid);
    }
  }

  /**
   * Get the number of active processes.
   */
  get size(): number {
    return this.processes.size;
  }

  /**
   * Route a shell:* message to the correct handler.
   */
  async handle(msg: WSMessage): Promise<WSResponse> {
    const action = msg.type.split(':')[1];

    switch (action) {
      case 'exec':
        return this.handleExec(msg);
      case 'kill':
        return this.handleKill(msg);
      default:
        throw new Error(`Unknown shell action: ${action}`);
    }
  }
}

import { createServer, request as httpRequest } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { execSync } from 'child_process';
import { rmSync, mkdirSync } from 'fs';
import {
  parseMessage,
  getNamespace,
  getDirection,
  createEvent,
  type WSResponse,
  type WSEvent,
} from './protocol.js';
import { handleFilesystem } from './handlers/filesystem.js';
import { TerminalManager } from './handlers/terminal.js';
import { ShellManager } from './handlers/shell.js';
import { PortDetector } from './handlers/port-detector.js';
import { handleSystem, createReadyEvent, createErrorEvent } from './handlers/system.js';
import { FileWatcher } from './watcher.js';

const DEFAULT_PORT = parseInt(process.env.AGENT_PORT ?? '8080', 10);

function getWorkdir(): string {
  return process.env.WORKDIR ?? '/home/sandbox/project';
}

/**
 * Clean the workdir so a recycled container starts fresh for a new session.
 * Removes all contents but preserves the directory itself.
 */
function cleanWorkdir(workdir: string): void {
  try {
    rmSync(workdir, { recursive: true, force: true });
    mkdirSync(workdir, { recursive: true });
    console.log(`[agent] Cleaned workdir: ${workdir}`);
  } catch (err) {
    console.error('[agent] Failed to clean workdir:', (err as Error).message);
  }
}

/**
 * Extract session ID from the WebSocket upgrade request URL.
 * Expected URL: /ws/{sessionId}
 */
function extractSessionId(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/\/ws\/([^/?#]+)/);
  return match ? match[1] : null;
}

const RELEASE_TIMEOUT_MS = 30_000; // 30s after disconnect, release container back to warm pool

/**
 * Proxy an HTTP request to the local Vite dev server on port 5173.
 * Forwards the full path so Vite (with base=/sandbox-preview/{sessionId}/) serves correctly.
 */
function proxyToVite(req: IncomingMessage, res: ServerResponse): void {
  const proxyReq = httpRequest(
    {
      hostname: '127.0.0.1',
      port: 5173,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: 'localhost:5173' },
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', () => {
    res.writeHead(503, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(
      '<html><head><script>' +
      'document.cookie="AWSALB=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/";' +
      'document.cookie="AWSALBTG=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/";' +
      'setTimeout(function(){location.reload()},2000);' +
      '</script></head><body><p>Loading preview...</p></body></html>',
    );
  });

  req.pipe(proxyReq);
}

/**
 * Start the WebSocket sidecar agent server.
 * Uses an HTTP server underneath so ALB health checks (GET /) get a 200 response.
 * Also proxies /sandbox-preview/{sessionId}/* requests to the local Vite dev server.
 *
 * Session-aware: only cleans the workdir when a NEW session connects (different ID).
 * Reconnects from the same session preserve files and running processes.
 */
export function startServer(port: number = DEFAULT_PORT): WebSocketServer {
  // ── Persistent state across reconnects ───────────────────────
  let currentSessionId: string | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;

  const httpServer = createServer((req, res) => {
    const url = req.url ?? '/';

    // ALB health check
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    // Preview proxy: /sandbox-preview/{sessionId}/...
    const match = url.match(/^\/sandbox-preview\/([^/]+)(\/.*)?$/);
    if (match) {
      const requestedSession = match[1];
      if (requestedSession !== currentSessionId) {
        // Wrong container — return retry page so ALB tries another
        res.writeHead(503, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        res.end(
          '<html><head><script>' +
          'document.cookie="AWSALB=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/";' +
          'document.cookie="AWSALBTG=;expires=Thu,01 Jan 1970 00:00:00 GMT;path=/";' +
          'setTimeout(function(){location.reload()},2000);' +
          '</script></head><body><p>Loading preview...</p></body></html>',
        );
        return;
      }
      proxyToVite(req, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server: httpServer });
  httpServer.listen(port);

  console.log(`[agent] WebSocket server listening on port ${port}`);

  let persistentShellManager: ShellManager | null = null;
  let persistentPortDetector: PortDetector | null = null;

  wss.on('connection', (ws: WebSocket, req) => {
    const sessionId = extractSessionId(req.url);

    // Cancel any pending release timer (reconnect or new session)
    if (releaseTimer) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }

    // Ignore connections without a valid session ID (e.g. ALB probes, stray requests)
    if (!sessionId) {
      console.log('[agent] Ignoring connection with no session ID');
      ws.close(4000, 'No session ID');
      return;
    }

    const isNewSession = sessionId !== currentSessionId;

    console.log(`[agent] Client connected (session=${sessionId}, new=${isNewSession})`);

    // ── Event emitter bound to this socket ────────────────────────

    const emit = (event: WSEvent): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };

    // ── Per-connection managers ───────────────────────────────────

    const workdir = getWorkdir();

    if (isNewSession) {
      // New session — kill old processes and clean workdir
      if (persistentShellManager) {
        persistentShellManager.destroyAll();
      }
      if (persistentPortDetector) {
        persistentPortDetector.stop();
      }
      // Nuclear cleanup: kill any orphaned dev servers that survived destroyAll().
      // Only run if there was a previous session (avoids killing unrelated processes
      // on first connection). Pattern excludes "vitest" to avoid killing test runners.
      if (currentSessionId) {
        try {
          execSync('pkill -9 -f "vite serve|vite dev|next dev" || true', { stdio: 'ignore' });
          execSync('lsof -t -i:5173 -i:3000 -i:3001 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true', { stdio: 'ignore' });
        } catch {
          // Best effort — process may not exist
        }
      }
      cleanWorkdir(workdir);
      currentSessionId = sessionId;

      // Set session-aware base path so Vite serves assets at
      // /sandbox-preview/{sessionId}/ — asset URLs route back through
      // CloudFront → ALB → sidecar proxy → Vite.
      if (sessionId) {
        process.env.PREVIEW_BASE_PATH = `/sandbox-preview/${sessionId}/`;
      }
    } else {
      console.log('[agent] Reconnect — preserving workdir and processes');
    }

    const terminalManager = new TerminalManager(emit);

    // Shell manager and port detector persist across reconnects for the same session
    if (isNewSession || !persistentShellManager) {
      persistentShellManager = new ShellManager(emit);
    } else {
      // Reconnect: update emitter to new WebSocket, keep processes alive
      persistentShellManager.setEmitter(emit);
    }

    if (isNewSession || !persistentPortDetector) {
      persistentPortDetector = new PortDetector(emit);
    } else {
      // Reconnect: update emitter to new WebSocket, keep port state intact
      persistentPortDetector.setEmitter(emit);
    }

    const shellManager = persistentShellManager;
    const portDetector = persistentPortDetector;
    const fileWatcher = new FileWatcher(emit, workdir);

    // Send system:ready and start background services
    emit(createReadyEvent(sessionId));
    portDetector.start();
    fileWatcher.start();

    // ── Message router ───────────────────────────────────────────

    ws.on('message', async (raw: Buffer | string) => {
      let msg;
      try {
        msg = parseMessage(typeof raw === 'string' ? raw : raw.toString('utf-8'));
      } catch (err) {
        emit(createErrorEvent('PARSE_ERROR', (err as Error).message));
        return;
      }

      // Only handle requests
      const direction = getDirection(msg.type);
      if (direction !== 'req') {
        emit(createErrorEvent('INVALID_DIRECTION', `Expected :req, got :${direction ?? 'unknown'}`));
        return;
      }

      const namespace = getNamespace(msg.type);
      if (!namespace) {
        emit(createErrorEvent('UNKNOWN_NAMESPACE', `Unknown namespace in type: ${msg.type}`));
        return;
      }

      try {
        let response: WSResponse | void;

        switch (namespace) {
          case 'fs':
            response = await handleFilesystem(msg, workdir);
            break;
          case 'terminal':
            response = await terminalManager.handle(msg);
            break;
          case 'shell':
            response = await shellManager.handle(msg);
            break;
          case 'port':
            response = portDetector.handle(msg);
            break;
          case 'system':
            response = handleSystem(msg);
            break;
          default:
            emit(createErrorEvent('UNKNOWN_NAMESPACE', `Unhandled namespace: ${namespace}`));
            return;
        }

        if (response && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(response));
        }
      } catch (err) {
        const errorMsg = (err as Error).message ?? 'Internal error';
        emit(createErrorEvent('HANDLER_ERROR', errorMsg));
      }
    });

    // ── Cleanup on disconnect ────────────────────────────────────
    // Only clean up terminal and file watcher — keep shell processes
    // and port detector running so the dev server survives reconnects.

    ws.on('close', () => {
      console.log('[agent] Client disconnected – keeping processes alive');
      terminalManager.destroyAll();
      fileWatcher.stop();
      // Note: shellManager and portDetector intentionally NOT stopped

      // Start release timer — if no reconnect within 30s, release container
      // Clear any existing timer first to prevent orphaned timers when
      // multiple WebSocket connections disconnect simultaneously.
      if (releaseTimer) {
        clearTimeout(releaseTimer);
      }
      releaseTimer = setTimeout(() => {
        console.log(`[agent] Release timeout — returning container to warm pool (was session ${currentSessionId})`);
        if (persistentShellManager) {
          persistentShellManager.destroyAll();
          persistentShellManager = null;
        }
        if (persistentPortDetector) {
          persistentPortDetector.stop();
          persistentPortDetector = null;
        }
        try {
          execSync('pkill -9 -f "vite serve|vite dev|next dev" || true', { stdio: 'ignore' });
          execSync('lsof -t -i:5173 -i:3000 -i:3001 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true', { stdio: 'ignore' });
        } catch { /* best effort */ }
        cleanWorkdir(getWorkdir());
        currentSessionId = null;
        releaseTimer = null;
      }, RELEASE_TIMEOUT_MS);
    });

    ws.on('error', (err) => {
      console.error('[agent] WebSocket error:', err.message);
    });
  });

  return wss;
}

// ── Main entry point ────────────────────────────────────────────────

// Only auto-start when run directly (not imported for tests)
const isMain =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('/server.js') || process.argv[1].endsWith('/server.ts'));

if (isMain) {
  startServer();
}

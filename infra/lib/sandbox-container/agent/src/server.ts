import { createServer, request as httpRequest } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';
import { connect as netConnect, type Socket } from 'net';
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
import { RoomRegistry } from './room-registry.js';

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
  // Anchored to the start of the path, and the id must be the whole final
  // segment: an unanchored match would read an id out of the query string, so
  // `/ws?/ws/{id}` — a path CloudFront does not require a signature for — would
  // open the session's socket.
  const match = url.match(/^\/ws\/([^/?#]+)\/?(?:[?#]|$)/);
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
 * Proxy a WebSocket upgrade to the local Vite dev server on port 5173.
 *
 * This is what makes Vite's HMR client work behind the preview proxy. The client
 * (served under base=/sandbox-preview/{sessionId}/) opens its own WebSocket back
 * to that same origin+path. Without this handler the upgrade lands on the agent's
 * own WebSocketServer, which rejects any path that is not /ws/{sessionId} — so the
 * HMR socket was closed immediately and the Vite client fell into an endless
 * "server connection lost. Polling for restart…" loop that never rendered.
 *
 * Vite 6 still injects @vite/client (and its ping loop) even with server.hmr:false,
 * so suppressing HMR in config is not enough — the socket has to actually connect.
 * Forwarding it here does that AND restores live hot-reload in the preview.
 *
 * A raw TCP splice (rather than re-parsing frames) keeps this protocol-agnostic:
 * we replay the initial upgrade bytes and then pipe both directions verbatim.
 */
function proxyUpgradeToVite(req: IncomingMessage, clientSocket: Socket, head: Buffer): void {
  console.log(`[agent] HMR upgrade → proxying to Vite:5173 (url=${req.url})`);
  const upstream = netConnect(5173, '127.0.0.1', () => {
    // Rebuild the request line + headers, forcing Host to the Vite origin so its
    // host check (allowedHosts) and HMR URL derivation behave as they do locally.
    const headers = { ...req.headers, host: 'localhost:5173' };
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
      .join('\r\n');
    upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headerLines}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    console.log(`[agent] HMR upgrade connected to Vite (url=${req.url})`);
  });

  const cleanup = (label: string) => (err?: Error) => {
    // Vite not up yet, or the client went away — expected during boot/reload, so
    // this is a warn, not an error. Logged so a persistently-failing HMR socket
    // (the "polling for restart" symptom) is visible in CloudWatch.
    console.warn(`[agent] HMR upgrade ${label} (url=${req.url})${err ? `: ${err.message}` : ''}`);
    upstream.destroy();
    clientSocket.destroy();
  };
  upstream.on('error', cleanup('upstream error'));
  clientSocket.on('error', cleanup('client error'));
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

  const wss = new WebSocketServer({ noServer: true });
  httpServer.listen(port);

  // Route WebSocket upgrades by path:
  //   /ws/{sessionId}            → the agent protocol (handled by `wss`)
  //   /sandbox-preview/{id}/...  → Vite's HMR socket, proxied to 127.0.0.1:5173
  //
  // Previously the agent's WebSocketServer was bound with `{ server: httpServer }`,
  // so it grabbed EVERY upgrade — including Vite's HMR socket on the preview path,
  // which it then rejected (no /ws/ session id), leaving the Vite client polling
  // forever and the template preview blank. Handling upgrades ourselves lets the
  // HMR socket reach Vite so the preview renders and hot-reloads.
  httpServer.on('upgrade', (req, socket, head) => {
    const url = req.url ?? '';
    const previewMatch = url.match(/^\/sandbox-preview\/([^/]+)(\/.*)?$/);

    if (previewMatch) {
      // Only proxy to Vite for the session this container is actually serving;
      // otherwise close so the client retries and ALB re-routes it.
      if (previewMatch[1] === currentSessionId) {
        proxyUpgradeToVite(req, socket as Socket, head);
      } else {
        console.warn(
          `[agent] HMR upgrade for session=${previewMatch[1]} but container serves ` +
            `session=${currentSessionId ?? 'none'} — closing so ALB re-routes`,
        );
        socket.destroy();
      }
      return;
    }

    // Everything else is the agent protocol.
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  console.log(`[agent] WebSocket server listening on port ${port}`);

  let persistentShellManager: ShellManager | null = null;
  let persistentPortDetector: PortDetector | null = null;
  let persistentFileWatcher: FileWatcher | null = null;

  // Real-time collaboration relay: fans opaque Yjs/Awareness frames out to
  // every peer editing the same session. Keyed by session ID, so it never
  // crosses the per-session isolation boundary enforced below.
  const rooms = new RoomRegistry();

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

    // Authorisation happens before the request gets here, in AWS-managed
    // services: CloudFront admits the upgrade only with a signed URL for this
    // session's path (issued by the session manager to the owner or an invited
    // member), and the ALB forwards only requests carrying CloudFront's
    // origin-verify header. This container accepts traffic only from the ALB.

    const isNewSession = sessionId !== currentSessionId;

    // Refuse a foreign session while this container is still serving live peers.
    //
    // Adopting it would run the destructive branch below (clean the workdir, kill
    // the dev server) out from under people who are actively editing. That is
    // reachable in practice: `/ws/*` is load-balanced across the whole warm pool,
    // so a connection for session X can land on the container serving session Y.
    // Closing is recoverable — the client retries and the routing layer sends it
    // to the right container — whereas a wipe destroys someone else's work.
    if (isNewSession && currentSessionId && rooms.peerCount(currentSessionId) > 0) {
      console.log(
        `[agent] Refusing session=${sessionId}: container is serving session=${currentSessionId} ` +
          `with ${rooms.peerCount(currentSessionId)} live peer(s)`,
      );
      ws.close(4001, 'Wrong container');
      return;
    }

    // Register this socket as a collaborator in its session's room. Peers who
    // present the SAME session ID are co-editors of the same project (invited
    // via the app's membership layer), so they are treated as reconnects, not
    // as a foreign session — the workdir wipe below only fires for a genuinely
    // different session ID.
    rooms.join(sessionId, ws);

    console.log(
      `[agent] Client connected (session=${sessionId}, new=${isNewSession}, peers=${rooms.peerCount(sessionId)})`,
    );

    // ── Event emitters ────────────────────────────────────────────

    /** Deliver an event to this socket only (request/response style). */
    const emit = (event: WSEvent): void => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };

    /**
     * Deliver an event to EVERY peer in this session's room.
     *
     * Shell output and detected ports describe shared container state, so all
     * collaborators need them. Binding those to a single socket meant the most
     * recent connection captured the stream — the other peers stopped receiving
     * it, and once that socket closed the events went nowhere at all. Resolving
     * the room on each call (rather than capturing a socket) keeps delivery
     * correct as peers come and go.
     */
    const emitToRoom = (event: WSEvent): void => {
      rooms.broadcastAll(sessionId, JSON.stringify(event));
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
      if (persistentFileWatcher) {
        persistentFileWatcher.stop();
        persistentFileWatcher = null;
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

    // A terminal is genuinely per-connection: each peer gets its own PTY, so its
    // output belongs to that peer alone.
    const terminalManager = new TerminalManager(emit);

    // Shell manager and port detector persist across reconnects for the same
    // session and emit to the whole room, so they need no re-binding when peers
    // join or leave — `emitToRoom` resolves the current membership per event.
    if (isNewSession || !persistentShellManager) {
      persistentShellManager = new ShellManager(emitToRoom);
    }

    if (isNewSession || !persistentPortDetector) {
      persistentPortDetector = new PortDetector(emitToRoom);
    }

    // One watcher per session, not per connection: it reports shared filesystem
    // state to the whole room, so a watcher per peer would emit the same change
    // once per peer (and re-read every changed file each time).
    if (isNewSession || !persistentFileWatcher) {
      persistentFileWatcher?.stop();
      persistentFileWatcher = new FileWatcher(emitToRoom, workdir);
      persistentFileWatcher.start();
    }

    const shellManager = persistentShellManager;
    const portDetector = persistentPortDetector;

    // Send system:ready and start background services
    emit(createReadyEvent(sessionId));
    portDetector.start();

    // Replay already-listening ports to this peer alone.
    //
    // `port:open:event` fires only when a port transitions to listening, so a
    // collaborator who joins after the dev server is already running would never
    // hear about it and their preview pane would stay empty. Re-announcing to
    // just the new socket (not the room) brings them up to date without
    // duplicating events for peers that already have them.
    for (const info of portDetector.getKnownPorts()) {
      emit(
        createEvent('port:open:event', {
          port: info.port,
          url: `http://localhost:${info.port}`,
          protocol: 'http',
        }),
      );
    }

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
        // Undefined by default: relay-style namespaces (yjs) fan frames out to
        // peers and return nothing to the sender.
        let response: WSResponse | void = undefined;

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
          case 'yjs':
            // Real-time collaboration relay. Frames are opaque base64 bytes
            // (Yjs sync + Awareness) — the server never decodes them; it just
            // fans them out to the OTHER peers in this session's room. No
            // response is returned to the sender: peers receive the frame
            // verbatim as a fresh message of the same type.
            rooms.broadcast(sessionId, ws, JSON.stringify(msg));
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
    // Only this peer's terminals go away. Shell processes, the port detector and
    // the file watcher are shared session state and must survive one peer
    // leaving so the remaining collaborators keep a working dev server, preview
    // and file tree.

    ws.on('close', () => {
      rooms.leave(sessionId, ws);
      const remainingPeers = rooms.peerCount(sessionId);
      console.log(
        `[agent] Client disconnected – keeping processes alive (peers left in session=${remainingPeers})`,
      );
      terminalManager.destroyAll();
      // Note: shellManager, portDetector and fileWatcher intentionally NOT
      // stopped — see above.

      // If collaborators are still connected to this session, do NOT start the
      // release timer — releasing would wipe the workdir out from under them.
      // The last peer to leave arms the timer, matching the original
      // single-connection behaviour.
      if (remainingPeers > 0) {
        return;
      }

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
        if (persistentFileWatcher) {
          persistentFileWatcher.stop();
          persistentFileWatcher = null;
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

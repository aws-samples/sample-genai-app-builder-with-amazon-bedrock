import { atom } from 'nanostores';
import type { RuntimeConnection, PortOpenEvent, PortCloseEvent, WSResponse } from '~/lib/runtime/types';
import { resolvePreviewUrl } from '~/lib/preview/preview-frame';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('PreviewsStore');

/**
 * How long to wait after a file change before reloading the preview.
 *
 * Long enough to collapse an AI turn's writes into one reload and let the dev
 * server settle; short enough that a change feels immediate.
 */
const RELOAD_DEBOUNCE_MS = 700;

/**
 * How many trailing lines of dev-command output to keep for the "Building…"
 * progress view. Enough to show recent npm/vite activity, bounded so the buffer
 * never grows without limit on a long install.
 */
const BUILD_OUTPUT_MAX_LINES = 12;

/**
 * The only port the preview route can actually serve.
 *
 * `/sandbox-preview/{sessionId}/` (on the untrusted-content origin) is proxied to Vite on 5173 by the sidecar, with
 * the target hard-coded (`sandbox-container/agent/src/server.ts:78`) — the URL does
 * not carry the port at all. So a preview published for any other port produces a
 * URL that still proxies to 5173, which is the app if it happens to be up and a 503
 * if it is not.
 *
 * That mattered because the container's detector scans 3000-9999 and the agent
 * itself listens on 8080: it reported its own socket as a project port the moment
 * the container started, the client published it, and the pane showed a 503 error
 * page instead of waiting. If the dev server never came up — a slow `npm install`
 * losing the race against the 120s request timeout — that error page was permanent.
 */
const PREVIEWABLE_PORT = 5173;

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  /** Resolve a healthy connection on demand; see {@link getConnection}. */
  #connect: () => Promise<RuntimeConnection>;
  #lastDevServerCommand: string | null = null;
  #restartInProgress = false;
  /**
   * Connections this store has already attached its listeners to.
   *
   * Subscribing is idempotent per connection but must happen again for a *new*
   * one: an explicit reconnect (`resetRuntimePromise`) builds a fresh
   * `RuntimeConnection`, and listeners left on the old object hear nothing.
   */
  #subscribed = new WeakSet<RuntimeConnection>();
  #pendingReload: ReturnType<typeof setTimeout> | null = null;
  #reloadResolvers: (() => void)[] = [];

  previews = atom<PreviewInfo[]>([]);

  /**
   * Counter that increments every time a port:open:event fires.
   * Components watch this to know when to reload the preview iframe.
   */
  reloadKey = atom(0);

  /**
   * Live tail of the dev command's output (npm install / vite), shown in the
   * "Building your project…" state so the preview pane isn't a blind spinner.
   * Kept to the last {@link BUILD_OUTPUT_MAX_LINES} lines.
   */
  buildOutput = atom<string[]>([]);
  #buildOutputBuffer: string[] = [];
  #buildOutputPartial = '';

  constructor(connect: () => Promise<RuntimeConnection>) {
    this.#connect = connect;

    // Best-effort at construction. Failure is fine and expected — this runs at
    // module import, before auth has hydrated — because every entry point that
    // needs port events resolves the connection again and subscribes then.
    void this.#ensureSubscribed();
  }

  /**
   * Attach port listeners to the current connection, if not already attached.
   *
   * Called on every operation rather than once in the constructor. Subscribing
   * once was the bug the other stores had already fixed: a first boot that
   * rejected left this store deaf to every port event for the life of the page,
   * so the preview pane spun forever with no way back but a reload.
   */
  async #ensureSubscribed(): Promise<RuntimeConnection | null> {
    let conn: RuntimeConnection;

    try {
      conn = await this.#connect();
    } catch (err) {
      logger.debug('Previews store could not reach the container; will retry on the next event:', err);
      return null;
    }

    if (this.#subscribed.has(conn)) {
      return conn;
    }

    this.#subscribed.add(conn);

    conn.on('port:open:event', (msg) => {
      const event = msg as unknown as PortOpenEvent;
      const { port, url } = event.payload;

      this.#publish(port, url);
    });

    conn.on('port:close:event', (msg: unknown) => {
      const event = msg as unknown as PortCloseEvent;
      const { port } = event.payload;

      if (this.#availablePreviews.has(port)) {
        this.#availablePreviews.delete(port);
        this.previews.set(this.previews.get().filter((preview) => preview.port !== port));

        this.#autoRestartDevServer(conn);
      }
    });

    // Refresh the preview when the project's files change.
    //
    // Nothing else does. A static site served by Vite has no HMR client in it —
    // no `<script type="module">`, so nothing in the page is listening for
    // Vite's full-reload — and the workbench never asked the iframe to refresh.
    // The result was a preview permanently one turn behind: a change appeared
    // only when the *next* artifact happened to trigger a reload for its own
    // reasons. Measured on non-prod, the editor held the new heading while the
    // preview served the old one for the entire 200s it was watched.
    conn.on('fs:change:event', () => this.#scheduleReload());

    // Re-query ports after WebSocket reconnection
    conn.on('system:reconnected', () => {
      logger.debug('Reconnected — re-querying active ports');
      void this.#refreshPorts(conn);
    });

    // Surface the dev command's output (npm install / vite) so the "Building
    // your project…" state shows live progress instead of a blind spinner.
    conn.on('shell:output:event', (msg: unknown) => {
      const event = msg as unknown as { payload?: { data?: string } };
      const data = event?.payload?.data;
      if (typeof data === 'string' && data.length > 0) {
        this.#appendBuildOutput(data);
      }
    });

    return conn;
  }

  /**
   * Append a chunk of dev-command output to the build-progress tail.
   *
   * The sidecar streams stdout/stderr in arbitrary chunks, not whole lines, so
   * we buffer a partial line across chunks, split on newlines, strip ANSI escape
   * codes (npm/vite colourise heavily), drop empty lines, and keep only the last
   * few so the view shows recent activity without unbounded growth.
   */
  #appendBuildOutput(chunk: string) {
    // eslint-disable-next-line no-control-regex
    const clean = (this.#buildOutputPartial + chunk).replace(/\u001b\[[0-9;]*m/g, '');
    const parts = clean.split(/\r?\n/);
    this.#buildOutputPartial = parts.pop() ?? '';

    const newLines = parts.map((l) => l.trimEnd()).filter((l) => l.length > 0);
    if (newLines.length === 0) {
      return;
    }

    this.#buildOutputBuffer = [...this.#buildOutputBuffer, ...newLines].slice(-BUILD_OUTPUT_MAX_LINES);
    this.buildOutput.set(this.#buildOutputBuffer);
  }

  /**
   * Reload the preview shortly, collapsing a burst of changes into one.
   *
   * An AI turn writes every file in the project, so reloading per event would
   * thrash the iframe and race the dev server mid-write. The delay also gives
   * Vite time to notice the change itself.
   */
  #scheduleReload() {
    if (this.previews.get().length === 0) {
      // Nothing to reload, and bumping the key would make the pane look busy
      // while it is actually waiting for a port.
      return;
    }

    if (this.#pendingReload) {
      clearTimeout(this.#pendingReload);
    }

    this.#pendingReload = setTimeout(() => {
      this.#pendingReload = null;
      this.reloadKey.set(this.reloadKey.get() + 1);

      const resolvers = this.#reloadResolvers;
      this.#reloadResolvers = [];
      resolvers.forEach((resolve) => resolve());
    }, RELOAD_DEBOUNCE_MS);
  }

  /**
   * Resolve once any pending reload has been applied.
   *
   * For tests: the debounce is otherwise invisible, and asserting on a timer from
   * the outside means guessing at it.
   */
  flushPendingReload(): Promise<void> {
    if (!this.#pendingReload) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.#reloadResolvers.push(resolve));
  }

  /** Record a listening port and make it the preview, if it is one we can serve. */
  #publish(port: number, url: string) {
    if (port !== PREVIEWABLE_PORT) {
      logger.debug(`Ignoring port ${port}; the preview route only serves ${PREVIEWABLE_PORT}`);
      return;
    }

    const baseUrl = this.#rewritePreviewUrl(url, port);
    const info: PreviewInfo = { port, ready: true, baseUrl };

    this.#availablePreviews.set(port, info);
    this.previews.set(Array.from(this.#availablePreviews.values()));
    this.reloadKey.set(this.reloadKey.get() + 1);
    this.#restartInProgress = false;

    // The app is up — the build log has served its purpose; clear it so a later
    // "Building…" state (e.g. a restart) starts fresh.
    this.#buildOutputBuffer = [];
    this.#buildOutputPartial = '';
    this.buildOutput.set([]);
  }

  /**
   * Reconcile the preview pane against the container when a new artifact starts.
   *
   * This replaces an unconditional `reset()`, which is what made the preview
   * stick on "Building your project..." after **every** follow-up prompt. The
   * container's port detector only emits `port:open:event` on the transition into
   * listening, so a dev server that was already up when the artifact began was
   * never re-announced — clearing the pane discarded the only notification the
   * client would ever get, in front of an app that was serving fine.
   *
   * Asking which ports are listening answers both cases from one source of
   * truth: a live dev server is kept, and a stale preview from a previous session
   * (the 502 this used to be reaching for) is dropped because the current
   * container does not report its port.
   */
  async onArtifactStart(): Promise<void> {
    const conn = await this.#ensureSubscribed();

    if (!conn) {
      // No connection to ask. Leaving the previews alone is the safer of the two
      // wrong answers: a stale preview is visibly wrong and self-corrects on the
      // next event, whereas clearing produces a spinner with no recovery path.
      return;
    }

    await this.#refreshPorts(conn);
  }

  /**
   * Record the dev server command so we can auto-restart it if the port closes.
   */
  setLastDevServerCommand(command: string) {
    this.#lastDevServerCommand = command;
  }

  /**
   * Clear all preview state.
   *
   * For a genuine session change only. Deliberately *not* called per artifact:
   * nulling `#lastDevServerCommand` also disables `#autoRestartDevServer`, which
   * is the only recovery path when a port really does close.
   */
  reset() {
    if (this.#pendingReload) {
      clearTimeout(this.#pendingReload);
      this.#pendingReload = null;
    }

    this.#availablePreviews.clear();
    this.previews.set([]);
    this.#lastDevServerCommand = null;
    this.#restartInProgress = false;
  }

  /**
   * Re-query the container for currently open ports and make the pane match.
   *
   * Reconciles in both directions: ports the container reports are published,
   * and previews for ports it no longer reports are dropped. A pull path is
   * necessary because `port:open:event` is edge-triggered — any client that
   * missed the edge (a reconnect, a late subscribe, a new artifact) has no other
   * way to learn a server is up.
   */
  async #refreshPorts(conn: RuntimeConnection) {
    let ports: number[];

    try {
      const response = await conn.request<WSResponse>({
        type: 'port:list:req',
        payload: {},
      });
      ports = ((response.payload as { ports?: Array<{ port: number }> })?.ports ?? [])
        .map((p) => p.port)
        .filter((port) => port === PREVIEWABLE_PORT);
    } catch (err) {
      // Leave the pane as it is rather than blanking it on a failed query.
      logger.debug('Failed to refresh ports:', err);
      return;
    }

    const listening = new Set(ports);

    for (const port of this.#availablePreviews.keys()) {
      if (!listening.has(port)) {
        this.#availablePreviews.delete(port);
      }
    }

    for (const port of ports) {
      if (!this.#availablePreviews.has(port)) {
        this.#availablePreviews.set(port, {
          port,
          ready: true,
          baseUrl: this.#rewritePreviewUrl(`http://localhost:${port}`, port),
        });
      }
    }

    this.previews.set(Array.from(this.#availablePreviews.values()));

    if (ports.length > 0) {
      this.reloadKey.set(this.reloadKey.get() + 1);
    } else if (this.#lastDevServerCommand) {
      await this.#autoRestartDevServer(conn);
    }
  }

  /**
   * Automatically restart the dev server when its port closes unexpectedly.
   */
  async #autoRestartDevServer(conn: RuntimeConnection) {
    if (!this.#lastDevServerCommand || this.#restartInProgress) return;

    this.#restartInProgress = true;
    logger.debug('Auto-restarting dev server:', this.#lastDevServerCommand);

    try {
      conn.request<WSResponse>({
        type: 'shell:exec:req',
        payload: {
          command: this.#lastDevServerCommand,
          env: { npm_config_yes: 'true' },
          streamOutput: true,
        },
      }).catch(() => {
        // Expected timeout for long-running dev servers
      });
    } catch (err) {
      logger.debug('Auto-restart failed:', err);
      this.#restartInProgress = false;
    }
  }

  /**
   * Rewrite the localhost URL from the sidecar to the CloudFront-proxied URL on
   * the untrusted-content origin.
   *
   * Never the app's own origin: the preview runs generated code, which there
   * could read the user's auth tokens. With no untrusted origin known the
   * localhost URL is kept, which simply fails to load.
   */
  #rewritePreviewUrl(url: string, port: number): string {
    if (typeof window === 'undefined') return url;

    if (window.location.protocol === 'https:') {
      const resolved = resolvePreviewUrl({
        previewUrl: (window as any).__SANDBOX_PREVIEW_URL__,
        previewDomain: (window as any).__SANDBOX_PREVIEW_DOMAIN__,
        sessionId: (window as any).__SANDBOX_SESSION_ID__,
        appOrigin: window.location.origin,
      });

      if (resolved) {
        return resolved;
      }

      logger.warn('No untrusted preview origin for this session; not loading the preview on the app origin');
    }

    return url;
  }
}

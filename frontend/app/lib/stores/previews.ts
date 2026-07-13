import { atom } from 'nanostores';
import type { RuntimeConnection, PortOpenEvent, PortCloseEvent, WSResponse } from '~/lib/runtime/types';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('PreviewsStore');

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  #connection: Promise<RuntimeConnection>;
  #lastDevServerCommand: string | null = null;
  #restartInProgress = false;

  previews = atom<PreviewInfo[]>([]);

  /**
   * Counter that increments every time a port:open:event fires.
   * Components watch this to know when to reload the preview iframe.
   */
  reloadKey = atom(0);

  constructor(connectionPromise: Promise<RuntimeConnection>) {
    this.#connection = connectionPromise;

    this.#init();
  }

  async #init() {
    const conn = await this.#connection;

    conn.on('port:open:event', (msg) => {
      const event = msg as unknown as PortOpenEvent;
      const { port, url } = event.payload;
      const rewrittenUrl = this.#rewritePreviewUrl(url, port);
      const previews = this.previews.get();

      const newPreviewInfo: PreviewInfo = { port, ready: true, baseUrl: rewrittenUrl };
      this.#availablePreviews.set(port, newPreviewInfo);

      const existingIndex = previews.findIndex((p) => p.port === port);

      if (existingIndex >= 0) {
        previews[existingIndex] = newPreviewInfo;
      } else {
        previews.push(newPreviewInfo);
      }

      this.previews.set([...previews]);
      this.reloadKey.set(this.reloadKey.get() + 1);
      this.#restartInProgress = false;
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

    // Re-query ports after WebSocket reconnection
    conn.on('system:reconnected', () => {
      logger.debug('Reconnected — re-querying active ports');
      this.#refreshPorts(conn);
    });
  }

  /**
   * Record the dev server command so we can auto-restart it if the port closes.
   */
  setLastDevServerCommand(command: string) {
    this.#lastDevServerCommand = command;
  }

  /**
   * Clear all preview state. Called when a new chat session starts
   * to prevent stale previews from a previous session being shown.
   */
  reset() {
    this.#availablePreviews.clear();
    this.previews.set([]);
    this.#lastDevServerCommand = null;
    this.#restartInProgress = false;
  }

  /**
   * Re-query the container for currently open ports.
   * Used after reconnection to recover preview state.
   */
  async #refreshPorts(conn: RuntimeConnection) {
    try {
      const response = await conn.request<WSResponse>({
        type: 'port:list:req',
        payload: {},
      });
      const ports = (response.payload as { ports?: Array<{ port: number }> })?.ports || [];

      for (const { port } of ports) {
        if (!this.#availablePreviews.has(port)) {
          const url = `http://localhost:${port}`;
          const rewrittenUrl = this.#rewritePreviewUrl(url, port);
          const info: PreviewInfo = { port, ready: true, baseUrl: rewrittenUrl };
          this.#availablePreviews.set(port, info);
        }
      }

      if (ports.length > 0) {
        this.previews.set(Array.from(this.#availablePreviews.values()));
        this.reloadKey.set(this.reloadKey.get() + 1);
      } else if (this.#lastDevServerCommand) {
        this.#autoRestartDevServer(conn);
      }
    } catch (err) {
      logger.debug('Failed to refresh ports:', err);
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
   * Rewrite the localhost URL from the sidecar to a CloudFront-proxied URL.
   */
  #rewritePreviewUrl(url: string, port: number): string {
    if (typeof window === 'undefined') return url;

    if (window.location.protocol === 'https:') {
      const sessionId = (window as any).__SANDBOX_SESSION_ID__ || '';

      if (sessionId) {
        return `${window.location.origin}/sandbox-preview/${sessionId}/`;
      }

      return `${window.location.origin}/sandbox-preview/`;
    }

    return url;
  }
}

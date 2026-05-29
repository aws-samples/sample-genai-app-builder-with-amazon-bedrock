import { atom } from 'nanostores';
import type { RuntimeConnection, PortOpenEvent, PortCloseEvent } from '~/lib/runtime/types';

export interface PreviewInfo {
  port: number;
  ready: boolean;
  baseUrl: string;
}

export class PreviewsStore {
  #availablePreviews = new Map<number, PreviewInfo>();
  #connection: Promise<RuntimeConnection>;

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

      // Always create a new object so React detects the reference change
      const newPreviewInfo: PreviewInfo = { port, ready: true, baseUrl: rewrittenUrl };
      this.#availablePreviews.set(port, newPreviewInfo);

      const existingIndex = previews.findIndex((p) => p.port === port);

      if (existingIndex >= 0) {
        previews[existingIndex] = newPreviewInfo;
      } else {
        previews.push(newPreviewInfo);
      }

      this.previews.set([...previews]);

      // Signal components to reload the iframe
      this.reloadKey.set(this.reloadKey.get() + 1);
    });

    conn.on('port:close:event', (msg: unknown) => {
      const event = msg as unknown as PortCloseEvent;
      const { port } = event.payload;

      if (this.#availablePreviews.has(port)) {
        this.#availablePreviews.delete(port);
        this.previews.set(this.previews.get().filter((preview) => preview.port !== port));
      }
    });
  }

  /**
   * Clear all preview state. Called when a new chat session starts
   * to prevent stale previews from a previous session being shown.
   */
  reset() {
    this.#availablePreviews.clear();
    this.previews.set([]);
  }

  /**
   * Rewrite the localhost URL from the sidecar to a CloudFront-proxied URL.
   * The sidecar emits http://localhost:{port} but the browser can't reach it
   * (mixed content + wrong host). Route through CloudFront /sandbox-preview/{sessionId}/
   * which the CloudFront Function rewrites and the ALB routes to the correct container.
   */
  #rewritePreviewUrl(url: string, port: number): string {
    if (typeof window === 'undefined') return url;

    // In production, rewrite to CloudFront-proxied preview path with session routing
    if (window.location.protocol === 'https:') {
      const sessionId = (window as any).__SANDBOX_SESSION_ID__ || '';

      if (sessionId) {
        return `${window.location.origin}/sandbox-preview/${sessionId}/`;
      }

      return `${window.location.origin}/sandbox-preview/`;
    }

    // In development, use the original localhost URL
    return url;
  }
}

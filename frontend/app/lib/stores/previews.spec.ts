import { describe, expect, it, vi } from 'vitest';
import { PreviewsStore } from './previews';
import type { RuntimeConnection } from '~/lib/runtime/types';

/**
 * A stand-in for the container connection.
 *
 * `listeningPorts` is what the container would answer `port:list:req` with, so a
 * test can model "the dev server is still up" independently of whether the client
 * happened to witness the `port:open:event` that announced it — which is the whole
 * problem area here.
 */
function fakeConnection(listeningPorts: number[] = []) {
  const handlers = new Map<string, ((msg: unknown) => void)[]>();
  const requests: { type: string }[] = [];

  const conn = {
    on(type: string, handler: (msg: unknown) => void) {
      const existing = handlers.get(type) ?? [];
      existing.push(handler);
      handlers.set(type, existing);
    },
    off(type: string, handler: (msg: unknown) => void) {
      handlers.set(type, (handlers.get(type) ?? []).filter((h) => h !== handler));
    },
    async request(msg: { type: string }) {
      requests.push(msg);

      if (msg.type === 'port:list:req') {
        return { payload: { ports: listeningPorts.map((port) => ({ port })) } };
      }

      return { payload: {} };
    },
  } as unknown as RuntimeConnection;

  return {
    conn,
    requests,
    handlerCount: (type: string) => (handlers.get(type) ?? []).length,
    emit(type: string, payload: unknown) {
      for (const handler of handlers.get(type) ?? []) {
        handler({ type, payload });
      }
    },
  };
}

/** Let the store's constructor-time async `#init` settle before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('PreviewsStore', () => {
  it('publishes a preview when the container opens the dev server port', async () => {
    const fake = fakeConnection();
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });

    expect(store.previews.get()).toHaveLength(1);
    expect(store.previews.get()[0].port).toBe(5173);
  });

  it("ignores the agent's own port", async () => {
    // The container's port detector scans 3000-9999 and the agent itself listens on
    // 8080, so it reports its own socket as a project port — before any app exists.
    // The preview URL ignores the port and always proxies to Vite on 5173
    // (sandbox-container/agent/src/server.ts:78), so publishing 8080 pointed the
    // iframe at a 503 and left it there. That error page, not the spinner, is what
    // a failed build actually looked like.
    const fake = fakeConnection();
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 8080, url: 'http://localhost:8080' });

    expect(store.previews.get()).toEqual([]);
  });

  it('ignores a port the preview route cannot serve', async () => {
    const fake = fakeConnection();
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 3000, url: 'http://localhost:3000' });

    expect(store.previews.get()).toEqual([]);
  });

  it('ignores non-servable ports when reconciling too', async () => {
    // port:list:req answers with every port the container sees, 8080 included.
    const fake = fakeConnection([8080, 5173]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    await store.onArtifactStart();

    expect(store.previews.get().map((p) => p.port)).toEqual([5173]);
  });

  it('keeps a live preview across a new artifact', async () => {
    // The regression: a follow-up prompt creates a new artifact, which cleared
    // every preview. `port:open:event` only fires on the transition into
    // listening, so the still-running dev server was never re-announced and the
    // pane showed "Building your project..." forever — in front of a working app.
    const fake = fakeConnection([5173]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });
    expect(store.previews.get()).toHaveLength(1);

    await store.onArtifactStart();

    expect(store.previews.get()).toHaveLength(1);
    expect(store.previews.get()[0].port).toBe(5173);
  });

  it('drops a preview whose port is no longer listening', async () => {
    // The case the old reset() was reaching for: a stale preview from a previous
    // session would 502. Answered by asking the container, not by assuming.
    const fake = fakeConnection([]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });
    expect(store.previews.get()).toHaveLength(1);

    await store.onArtifactStart();

    expect(store.previews.get()).toEqual([]);
  });

  it('remembers the dev server command across a new artifact', async () => {
    // reset() nulled this, which disabled the auto-restart that is the only
    // recovery path when the port genuinely closes.
    const fake = fakeConnection([]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    store.setLastDevServerCommand('npm run dev');
    await store.onArtifactStart();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });
    fake.emit('port:close:event', { port: 5173 });
    await settle();

    expect(fake.requests.some((r) => r.type === 'shell:exec:req')).toBe(true);
  });

  it('subscribes to port events even when the first connect attempt fails', async () => {
    // The store used to subscribe exactly once, in its constructor. Auth has not
    // always hydrated by then, and on rejection it returned — leaving the pane
    // permanently deaf to every port event for the life of the page.
    const fake = fakeConnection([]);
    let attempt = 0;
    const connect = vi.fn(async () => {
      attempt += 1;

      if (attempt === 1) {
        throw new Error('auth not ready');
      }

      return fake.conn;
    });

    const store = new PreviewsStore(connect);
    await settle();

    await store.onArtifactStart();
    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });

    expect(store.previews.get()).toHaveLength(1);
  });

  it('does not subscribe twice to the same connection', async () => {
    const fake = fakeConnection([5173]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    await store.onArtifactStart();
    await store.onArtifactStart();

    expect(fake.handlerCount('port:open:event')).toBe(1);
  });

  it('reloads the preview when the container reports a file change', async () => {
    // The file lands on disk and the preview keeps serving the old page. A plain
    // static site has no Vite HMR client in it — no `<script type="module">`, so
    // nothing is listening for Vite's full-reload — and the workbench never asked
    // the iframe to refresh either. Measured on non-prod: the editor held the new
    // heading while the preview showed the old one for 200s.
    const fake = fakeConnection([5173]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });

    const before = store.reloadKey.get();
    fake.emit('fs:change:event', { path: 'index.html' });
    await store.flushPendingReload();

    expect(store.reloadKey.get()).toBeGreaterThan(before);
  });

  it('collapses a burst of file changes into one reload', async () => {
    // An AI turn writes every file in the project. One reload per file would
    // thrash the iframe and race the dev server mid-write.
    const fake = fakeConnection([5173]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });

    const before = store.reloadKey.get();

    for (const path of ['a.js', 'b.js', 'c.js', 'index.html']) {
      fake.emit('fs:change:event', { path });
    }

    await store.flushPendingReload();

    expect(store.reloadKey.get()).toBe(before + 1);
  });

  it('does not reload when there is no preview to reload', async () => {
    const fake = fakeConnection([]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    const before = store.reloadKey.get();
    fake.emit('fs:change:event', { path: 'index.html' });
    await store.flushPendingReload();

    expect(store.reloadKey.get()).toBe(before);
  });

  it('clears everything on an explicit session reset', async () => {
    const fake = fakeConnection([5173]);
    const store = new PreviewsStore(async () => fake.conn);
    await settle();

    fake.emit('port:open:event', { port: 5173, url: 'http://localhost:5173' });
    store.reset();

    expect(store.previews.get()).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { getFileText } from './codemirror-collab';
import { startCollabAutosave } from './collab-autosave';

/**
 * Live co-editing was visible but not durable.
 *
 * A collaborator's keystrokes reach the other peer through the shared `Y.Text` and
 * are rendered by the CodeMirror binding, so both people watch the file change. But
 * nothing ever wrote that content to the container's filesystem: the only paths to
 * disk are the explicit save (`Ctrl+S` / the save button) and an AI action. So the
 * dev server never rebuilt, and on the next reload the doc was re-seeded from disk
 * and every co-edit was simply gone — which is exactly "you see their app changes,
 * but these changes don't persist through refresh".
 *
 * Saving is deliberately NOT restricted to the peer who typed. Both peers share one
 * container, so either can persist the same content; whichever debounce fires first
 * writes, and the other then sees disk already matching and skips. That redundancy
 * is the point — a collaborator who closes their tab mid-edit still has their work
 * written by the peer who is left.
 */
describe('startCollabAutosave', () => {
  const PATH = '/home/sandbox/project/src/App.tsx';

  let disk: Map<string, string>;
  let saved: Array<{ filePath: string; content: string }>;

  function deps(overrides: Partial<Parameters<typeof startCollabAutosave>[1]> = {}) {
    return {
      diskContent: (filePath: string) => disk.get(filePath),
      save: async (filePath: string, content: string) => {
        saved.push({ filePath, content });
        disk.set(filePath, content);
      },
      delayMs: 500,
      ...overrides,
    };
  }

  /** Apply a peer's edit the way the provider does: a remote-origin transaction. */
  function peerTypes(doc: Y.Doc, filePath: string, insert: string, at: number) {
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getText(`files:${filePath}`).insert(at, insert);
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(peer), 'remote');
  }

  beforeEach(() => {
    vi.useFakeTimers();
    disk = new Map([[PATH, 'const a = 1;']]);
    saved = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes a collaborator's edit to the container so it survives a reload", async () => {
    const doc = new Y.Doc();
    getFileText(doc, PATH, disk.get(PATH)!);
    const stop = startCollabAutosave(doc, deps());

    peerTypes(doc, PATH, ' // theirs', 12);
    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(saved).toEqual([{ filePath: PATH, content: 'const a = 1; // theirs' }]);
  });

  it('debounces a burst of keystrokes into a single write', async () => {
    const doc = new Y.Doc();
    getFileText(doc, PATH, disk.get(PATH)!);
    const stop = startCollabAutosave(doc, deps());

    for (const char of 'abc') {
      peerTypes(doc, PATH, char, 12);
      await vi.advanceTimersByTimeAsync(100);
    }

    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(saved).toHaveLength(1);
    expect(saved[0].content).toBe('const a = 1;cba');
  });

  it('writes nothing when the shared text already matches disk', async () => {
    const doc = new Y.Doc();

    const stop = startCollabAutosave(doc, deps());
    // Opening a file seeds its Y.Text from disk. That is a doc change, but not an
    // edit — writing it back would fire a container file event for nothing.
    getFileText(doc, PATH, disk.get(PATH)!);

    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(saved).toEqual([]);
  });

  it('leaves the chat map alone — it is not a file', async () => {
    const doc = new Y.Doc();
    const stop = startCollabAutosave(doc, deps());

    doc.getMap<string>('chat:messages').set('m1', '{"role":"user","content":"hi","order":0}');
    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(saved).toEqual([]);
  });

  it('does not write a path the container has no file for', async () => {
    const doc = new Y.Doc();
    const stop = startCollabAutosave(doc, deps());

    // Nothing on disk: writing would resurrect a deleted file, or invent one the
    // files store has never seen.
    peerTypes(doc, '/home/sandbox/project/gone.tsx', 'zombie', 0);
    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(saved).toEqual([]);
  });

  it('writes each edited file separately', async () => {
    const other = '/home/sandbox/project/src/index.css';
    disk.set(other, 'body {}');

    const doc = new Y.Doc();
    getFileText(doc, PATH, disk.get(PATH)!);
    getFileText(doc, other, disk.get(other)!);
    const stop = startCollabAutosave(doc, deps());

    peerTypes(doc, PATH, '!', 12);
    peerTypes(doc, other, '!', 7);
    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(saved.map((write) => write.filePath).sort()).toEqual([other, PATH].sort());
  });

  it('stops writing once collaboration is torn down', async () => {
    const doc = new Y.Doc();
    getFileText(doc, PATH, disk.get(PATH)!);
    const stop = startCollabAutosave(doc, deps());

    peerTypes(doc, PATH, 'x', 12);
    stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(saved).toEqual([]);
  });

  it('keeps saving after a write fails', async () => {
    const doc = new Y.Doc();
    getFileText(doc, PATH, disk.get(PATH)!);

    let attempts = 0;
    const stop = startCollabAutosave(
      doc,
      deps({
        save: async (filePath: string, content: string) => {
          attempts++;

          if (attempts === 1) {
            throw new Error('fs:write failed');
          }

          saved.push({ filePath, content });
        },
      }),
    );

    peerTypes(doc, PATH, 'x', 12);
    await vi.advanceTimersByTimeAsync(500);

    peerTypes(doc, PATH, 'y', 12);
    await vi.advanceTimersByTimeAsync(500);
    stop();

    expect(attempts).toBe(2);
    expect(saved).toHaveLength(1);
  });
});

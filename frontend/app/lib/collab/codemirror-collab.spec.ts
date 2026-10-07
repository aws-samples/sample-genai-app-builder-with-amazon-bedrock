import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { getFileText } from './codemirror-collab';

/**
 * These tests cover the seeding contract in isolation (no CodeMirror view):
 * the first client to open a file seeds its Y.Text from container content, and
 * a second client that already received the content via sync must not
 * duplicate it.
 */
describe('getFileText seeding', () => {
  it('seeds an empty file text from container content on first open', () => {
    const doc = new Y.Doc();
    const ytext = getFileText(doc, 'src/App.tsx', 'const x = 1;');
    expect(ytext.toString()).toBe('const x = 1;');
  });

  it('is idempotent — opening the same file twice does not duplicate content', () => {
    const doc = new Y.Doc();
    getFileText(doc, 'src/App.tsx', 'hello');
    const again = getFileText(doc, 'src/App.tsx', 'hello');
    expect(again.toString()).toBe('hello');
  });

  it('does not re-seed a file that arrived via sync (no duplication)', () => {
    // Simulate: peer A seeds, its state is synced into peer B's doc, then B
    // opens the same file. B must NOT insert the content again.
    const docA = new Y.Doc();
    getFileText(docA, 'src/App.tsx', 'shared body');

    const docB = new Y.Doc();
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    const ytextB = getFileText(docB, 'src/App.tsx', 'shared body');
    expect(ytextB.toString()).toBe('shared body');
  });

  it('converges to a single copy when two peers seed concurrently before sync', () => {
    // The hard case: both peers cold-open the same file BEFORE their first
    // sync crosses, so each sees an empty doc and seeds independently. A naive
    // local `insert()` from two different client ids concatenates on merge,
    // duplicating the file. A deterministic seed must dedupe to one copy.
    const content = 'export default function App() {}';

    const docA = new Y.Doc();
    const docB = new Y.Doc();

    // Both seed while still disconnected.
    getFileText(docA, 'src/App.tsx', content);
    getFileText(docB, 'src/App.tsx', content);

    // Now they sync in both directions (order-independent for CRDTs).
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    expect(docA.getText('files:src/App.tsx').toString()).toBe(content);
    expect(docB.getText('files:src/App.tsx').toString()).toBe(content);
  });

  it('lets both peers keep editing after a concurrent seed and still converge', () => {
    // Guards against the seed client id leaking into live editing: after both
    // peers seed the same file concurrently, each makes a local edit, then they
    // exchange updates. Result must be a single seeded copy plus both edits.
    const content = 'AB';
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const key = 'files:src/App.tsx';

    getFileText(docA, 'src/App.tsx', content);
    getFileText(docB, 'src/App.tsx', content);

    // Converge the seeds first (real peers sync before editing).
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    // Peer A prepends, peer B appends — as their own editing clients.
    docA.getText(key).insert(0, 'a>');
    docB.getText(key).insert(docB.getText(key).length, '<b');

    // Exchange the edits.
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB));
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));

    expect(docA.getText(key).toString()).toBe('a>AB<b');
    expect(docB.getText(key).toString()).toBe('a>AB<b');
  });

  it('keeps separate text per file path', () => {
    const doc = new Y.Doc();
    const a = getFileText(doc, 'a.ts', 'AAA');
    const b = getFileText(doc, 'b.ts', 'BBB');
    expect(a.toString()).toBe('AAA');
    expect(b.toString()).toBe('BBB');
  });

  it('does not seed when container content is empty', () => {
    const doc = new Y.Doc();
    const ytext = getFileText(doc, 'empty.ts', '');
    expect(ytext.toString()).toBe('');
    // An empty file writes nothing to the doc — no seed structs at all.
    expect(Y.encodeStateVector(doc).length).toBe(1);
  });
});

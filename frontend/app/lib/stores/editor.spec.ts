import { describe, expect, it } from 'vitest';
import { EditorStore } from './editor';
import type { FileMap, FilesStore } from './files';

/**
 * `setDocuments` rebuilds every open document from the files store, and used to
 * take `value` from disk unconditionally — so ANY file event from the container
 * discarded every unsaved editor buffer (TEST_REPORT defect 18).
 *
 * Multiplayer makes that far worse rather than merely exposing it. Solo, the only
 * sources of a file event are your own saves and your own AI turns. With a second
 * person in the container every file they touch fires the effect for you, and
 * auto-saving a collaborator's CRDT edits turns their typing into a steady stream of
 * events — so the more collaborative the session, the more often unsaved work
 * silently reverts.
 *
 * `unsavedFiles` already records exactly which buffers must not be overwritten, and
 * is only ever written for the selected document, so it cannot disagree with the
 * file that actually changed.
 */
describe('EditorStore.setDocuments', () => {
  /** EditorStore keeps a FilesStore reference but reads nothing off it. */
  function store() {
    return new EditorStore({} as FilesStore);
  }

  function file(content: string) {
    return { type: 'file', content, isBinary: false } as const;
  }

  const disk: FileMap = {
    '/home/sandbox/project/App.tsx': file('on disk'),
    '/home/sandbox/project/index.css': file('body {}'),
  };

  it('takes content from disk for documents nobody has edited', () => {
    const editor = store();
    editor.setDocuments(disk);

    expect(editor.documents.get()['/home/sandbox/project/App.tsx'].value).toBe('on disk');
  });

  it('keeps an unsaved buffer when an unrelated file changes', () => {
    const editor = store();
    editor.setDocuments(disk);
    editor.updateFile('/home/sandbox/project/index.css', 'body { color: red }');

    // A collaborator saves App.tsx, so the whole file map is republished.
    editor.setDocuments(
      { ...disk, '/home/sandbox/project/App.tsx': file('theirs') },
      new Set(['/home/sandbox/project/index.css']),
    );

    expect(editor.documents.get()['/home/sandbox/project/index.css'].value).toBe('body { color: red }');
    expect(editor.documents.get()['/home/sandbox/project/App.tsx'].value).toBe('theirs');
  });

  it('takes disk content again once the buffer has been saved', () => {
    const editor = store();
    editor.setDocuments(disk);
    editor.updateFile('/home/sandbox/project/index.css', 'body { color: red }');

    // Saved: the path is no longer dirty, so disk is authoritative again.
    editor.setDocuments({ ...disk, '/home/sandbox/project/index.css': file('body { color: red }') }, new Set());

    expect(editor.documents.get()['/home/sandbox/project/index.css'].value).toBe('body { color: red }');
  });

  it('preserves scroll position as it always did', () => {
    const editor = store();
    editor.setDocuments(disk);
    editor.updateScrollPosition('/home/sandbox/project/App.tsx', { top: 40, left: 0 });
    editor.setDocuments(disk);

    expect(editor.documents.get()['/home/sandbox/project/App.tsx'].scroll).toEqual({ top: 40, left: 0 });
  });

  it('does not resurrect a dirty document whose file has gone', () => {
    const editor = store();
    editor.setDocuments(disk);
    editor.updateFile('/home/sandbox/project/index.css', 'body { color: red }');

    const withoutCss = { ...disk, '/home/sandbox/project/index.css': undefined };
    editor.setDocuments(withoutCss, new Set(['/home/sandbox/project/index.css']));

    expect(editor.documents.get()['/home/sandbox/project/index.css']).toBeUndefined();
  });

  it('overwrites every buffer when no dirty set is supplied, as before', () => {
    const editor = store();
    editor.setDocuments(disk);
    editor.updateFile('/home/sandbox/project/index.css', 'body { color: red }');
    editor.setDocuments(disk);

    expect(editor.documents.get()['/home/sandbox/project/index.css'].value).toBe('body {}');
  });
});

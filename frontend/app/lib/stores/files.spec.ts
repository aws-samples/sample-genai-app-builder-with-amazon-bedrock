import { beforeEach, describe, expect, it } from 'vitest';
import { FilesStore } from './files';
import type { RuntimeConnection } from '~/lib/runtime/types';

/**
 * `saveFile` refused to write any file whose current content was empty.
 *
 * It guarded on `!oldContent`, which is true for `''` as well as for "no such
 * file", and answered by calling `unreachable()` — so saving a file that happened
 * to be empty threw instead of writing. Reaching it by hand took a deliberate
 * sequence (create an empty file, type, save), which is why it went unnoticed; with
 * collaborative edits auto-saved it becomes routine, since a newly created file
 * starts empty and the first thing anyone does is type into it.
 */
describe('FilesStore.saveFile', () => {
  const PATH = '/home/sandbox/project/src/App.tsx';

  let writes: Array<{ path: string; content: string }>;
  let store: FilesStore;

  function fakeConnection(): RuntimeConnection {
    return {
      on: () => {},
      request: async (message: any) => {
        if (message.type === 'fs:write:req') {
          writes.push({ path: message.payload.path, content: message.payload.content });
          return { payload: {} };
        }

        return { payload: { files: [] } };
      },
    } as unknown as RuntimeConnection;
  }

  beforeEach(async () => {
    writes = [];
    store = new FilesStore(async () => fakeConnection());

    // Let the constructor's initial sync settle before seeding the map directly.
    await Promise.resolve();
  });

  it('writes a file that had content', async () => {
    store.files.setKey(PATH, { type: 'file', content: 'const a = 1;', isBinary: false });

    await store.saveFile(PATH, 'const a = 2;');

    expect(writes).toEqual([{ path: 'src/App.tsx', content: 'const a = 2;' }]);
    expect(store.getFile(PATH)?.content).toBe('const a = 2;');
  });

  it('writes a file that was empty, rather than treating empty as absent', async () => {
    store.files.setKey(PATH, { type: 'file', content: '', isBinary: false });

    await store.saveFile(PATH, 'first line');

    expect(writes).toEqual([{ path: 'src/App.tsx', content: 'first line' }]);
  });

  it('still refuses a path the container has no file for', async () => {
    await expect(store.saveFile('/home/sandbox/project/missing.tsx', 'x')).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});

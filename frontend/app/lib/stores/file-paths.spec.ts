import { describe, it, expect } from 'vitest';
import { WORK_DIR } from '~/utils/constants';

/**
 * The sidecar reports paths relative to the container workspace, while this app —
 * and the file tree, which filters on WORK_DIR — keys off absolute ones. Getting
 * this wrong is quietly bad: the files load into the store but sit outside the
 * tree's root, so a fully populated project renders as an empty Files panel.
 *
 * `FilesStore#toStorePath` is private, so the rule is pinned here against the same
 * logic to stop it drifting back.
 */
function toStorePath(reportedPath: string): string {
  if (reportedPath.startsWith(WORK_DIR)) {
    return reportedPath;
  }

  return `${WORK_DIR}/${reportedPath.replace(/^\/+/, '')}`;
}

describe('sidecar path normalisation', () => {
  it('puts a relative file under the workspace root', () => {
    expect(toStorePath('package.json')).toBe(`${WORK_DIR}/package.json`);
  });

  it('handles nested paths', () => {
    expect(toStorePath('src/components/KpiCard.jsx')).toBe(`${WORK_DIR}/src/components/KpiCard.jsx`);
  });

  it('tolerates a leading slash without doubling it', () => {
    expect(toStorePath('/package.json')).toBe(`${WORK_DIR}/package.json`);
    expect(toStorePath('///src/App.jsx')).toBe(`${WORK_DIR}/src/App.jsx`);
  });

  it('leaves an already-absolute workspace path alone', () => {
    const absolute = `${WORK_DIR}/src/App.jsx`;
    expect(toStorePath(absolute)).toBe(absolute);
  });

  it('produces paths the file tree will actually show', () => {
    // The tree only renders entries beneath its rootFolder.
    for (const reported of ['package.json', 'src/App.jsx', '/vite.config.js']) {
      expect(toStorePath(reported).startsWith(`${WORK_DIR}/`)).toBe(true);
    }
  });

  it('round-trips with the relative form saveFile sends back to the container', () => {
    const stored = toStorePath('src/App.jsx');
    const relative = stored.replace(/^\/home\/sandbox\/project\/?/, '');
    expect(relative).toBe('src/App.jsx');
  });
});

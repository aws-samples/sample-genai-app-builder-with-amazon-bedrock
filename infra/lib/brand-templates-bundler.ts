import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Local bundler for the brand-templates Python Lambda.
//
// Why this exists: Code.fromAsset({bundling}) defaults to Docker. CI
// runners and dev machines without Docker fail synth with
// `spawnSync docker ENOENT`. This bundler runs `pip install` directly
// on the host, downloading platform-pinned wheels for the Lambda
// runtime so the bundle is deployable, not a stub.
//
// Constraints we hit in the field:
//   - GitLab `node:20` images ship `python3.11` but no `pip` module
//     (Debian splits it into `python3-pip`). We bootstrap a
//     standalone pip when `python -m pip` is unavailable.
//   - The host Python version doesn't have to match the target — pip
//     resolves wheels from `--platform`/`--python-version`, not the
//     host interpreter. We just need ≥ 3.10 because that's pip.pyz's
//     minimum.
//
// Returns false on any failure so CDK falls back to Docker.

const PIP_PYZ_URL = 'https://bootstrap.pypa.io/pip/pip.pyz';
const PIP_PYZ_CACHE = path.join(os.tmpdir(), 'bv-bundler-pip.pyz');

function tryRun(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function findPython(): string | null {
  for (const bin of ['python3.12', 'python3.11', 'python3.10']) {
    if (tryRun(`command -v ${bin}`)) return bin;
  }
  return null;
}

function pipInvocation(python: string): string {
  if (tryRun(`${python} -m pip --version`)) return `${python} -m pip`;

  if (!fs.existsSync(PIP_PYZ_CACHE)) {
    process.stderr.write(`[bundle] ${python} has no pip module; fetching pip.pyz\n`);
    // Atomic install: download to a per-process staging path then
    // fs.renameSync into the cache slot. rename(2) on the same FS is
    // atomic — concurrent bundler processes see either the old file, the
    // new file, or no file, but never a half-written one. This is the
    // only correctness guarantee we actually need; pip.pyz is a Python
    // zipapp (shebang + zip), so a content-shape check at offset 0 would
    // be wrong (zipapps don't start with PK\x03\x04). If the cache ever
    // does end up corrupt for some other reason, pip itself will throw
    // when invoked and the bundler returns false.
    const stagingPath = `${PIP_PYZ_CACHE}.${process.pid}.tmp`;
    try {
      if (tryRun('command -v curl')) {
        execSync(`curl -fsSL -o "${stagingPath}" "${PIP_PYZ_URL}"`, { stdio: 'inherit' });
      } else if (tryRun('command -v wget')) {
        execSync(`wget -q -O "${stagingPath}" "${PIP_PYZ_URL}"`, { stdio: 'inherit' });
      } else {
        throw new Error('neither curl nor wget available to fetch pip.pyz');
      }
      // Sanity check: download produced a non-empty file. Anything beyond
      // this (zip integrity, etc.) belongs to pip when it actually runs.
      const stat = fs.statSync(stagingPath);
      if (stat.size === 0) {
        throw new Error('downloaded pip.pyz is empty');
      }
      // If a sibling worker raced us and already published a valid file,
      // rename-over-self is still atomic and a no-op behaviorally.
      fs.renameSync(stagingPath, PIP_PYZ_CACHE);
    } catch (err) {
      try { fs.unlinkSync(stagingPath); } catch { /* best effort */ }
      throw err;
    }
  }
  return `${python} "${PIP_PYZ_CACHE}"`;
}

export function bundleBrandTemplatesLambda(srcDir: string, outputDir: string): boolean {
  // Test fast path: copy sources only, skip `pip install` entirely.
  //
  // Jest synthesizes the stack repeatedly and runs workers in parallel; doing
  // a real pip install per worker is slow AND races on the shared pip.pyz
  // cache, which previously produced torn writes ("Non-UTF-8 code starting
  // with '\xf2'"). Tests don't exercise the Lambda payload — they only assert
  // CDK output shape — so the dependency-free copy is sufficient and
  // returning true short-circuits Docker fallback (which CI runners don't
  // have).
  if (process.env.BV_SKIP_LAMBDA_BUNDLE === '1') {
    try {
      execSync(
        `cp -a "${srcDir}/." "${outputDir}/" && ` +
          `find "${outputDir}" -type d \\( -name '__pycache__' -o -name '.venv' -o -name '.pytest_cache' -o -name 'tests' \\) -prune -exec rm -rf {} +`,
        { stdio: 'inherit', shell: '/bin/bash' },
      );
      return true;
    } catch (err) {
      process.stderr.write(`[bundle] BV_SKIP_LAMBDA_BUNDLE copy failed: ${err}\n`);
      return false;
    }
  }

  const python = findPython();
  if (!python) {
    process.stderr.write('[bundle] no Python ≥ 3.10 found; falling back to Docker.\n');
    return false;
  }
  try {
    const pip = pipInvocation(python);
    execSync(
      [
        `${pip} install --quiet --disable-pip-version-check`,
        `  -r "${srcDir}/requirements.txt"`,
        `  -t "${outputDir}"`,
        `  --platform manylinux2014_aarch64`,
        `  --only-binary=:all:`,
        `  --python-version 3.12`,
        `  --implementation cp`,
        `  --upgrade`,
      ].join(' \\\n'),
      { stdio: 'inherit', shell: '/bin/bash' },
    );
    execSync(
      `cp -a "${srcDir}/." "${outputDir}/" && ` +
        `find "${outputDir}" -type d \\( -name '__pycache__' -o -name '.venv' -o -name '.pytest_cache' -o -name 'tests' \\) -prune -exec rm -rf {} +`,
      { stdio: 'inherit', shell: '/bin/bash' },
    );
    return true;
  } catch (err) {
    process.stderr.write(`[bundle] local bundler failed for BrandTemplatesLambda: ${err}\n`);
    return false;
  }
}

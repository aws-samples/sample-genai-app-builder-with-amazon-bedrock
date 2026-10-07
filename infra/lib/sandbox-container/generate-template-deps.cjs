/**
 * Stages the react-starter-pack dependency manifests into the sandbox container
 * build context so the Docker build can pre-warm an npm cache with the template's
 * (heavy) deps — Cloudscape, Amplify, etc. This makes the FIRST `npm install`
 * inside a template-seeded sandbox a cache hit instead of a cold download.
 *
 * Copies only package.json + package-lock.json for frontend and backend (NOT
 * node_modules or source) from the pinned submodule into
 * infra/lib/sandbox-container/template-deps/. Keyed to the submodule, so run it
 * whenever the submodule pin changes (wired into the container-image build).
 *
 * The staged files are a build artifact and are gitignored.
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..', '..');
const SUBMODULE = path.join(REPO_ROOT, 'frontend', 'react-starter-pack');
const OUT_DIR = path.join(__dirname, 'template-deps');

const FILES = [
  ['frontend/package.json', 'frontend/package.json'],
  ['frontend/package-lock.json', 'frontend/package-lock.json'],
  ['backend/functions/package.json', 'backend/package.json'],
  ['backend/functions/package-lock.json', 'backend/package-lock.json'],
];

function main() {
  if (!fs.existsSync(path.join(SUBMODULE, 'frontend', 'package.json'))) {
    console.error(
      `react-starter-pack submodule not found/initialized at ${SUBMODULE}. ` +
        `Run: git submodule update --init --recursive`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.join(OUT_DIR, 'frontend'), { recursive: true });
  fs.mkdirSync(path.join(OUT_DIR, 'backend'), { recursive: true });

  let copied = 0;
  for (const [src, dest] of FILES) {
    const s = path.join(SUBMODULE, src);
    const d = path.join(OUT_DIR, dest);
    if (!fs.existsSync(s)) {
      console.warn(`skip (missing): ${src}`);
      continue;
    }
    fs.copyFileSync(s, d);
    copied++;
  }

  console.log(`Staged ${copied} template dependency manifest(s) into ${path.relative(REPO_ROOT, OUT_DIR)}`);
}

main();

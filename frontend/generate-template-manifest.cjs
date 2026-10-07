/**
 * Generates app/lib/templates/rsp-manifest.ts from the react-starter-pack
 * submodule so the "Enable GenAIIC Template" toggle can seed a fresh sandbox
 * with the starter-pack tree at runtime (over the fs API) — no Docker bake.
 *
 * Runs at build time (see the `prebuild`/generate step in package.json),
 * mirroring generate-build-config.cjs. Text files are embedded as UTF-8,
 * binary assets (images/icons) as base64.
 *
 * Excludes files that are irrelevant to a running app (RSP's own docs, CI,
 * agent rules, demo media) to keep the bundle small.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SUBMODULE_DIR = path.join(__dirname, 'react-starter-pack');
const OUT_FILE = path.join(__dirname, 'app', 'lib', 'templates', 'rsp-manifest.ts');

// Paths (relative to the submodule root) that should NOT be seeded.
const EXCLUDE_PREFIXES = [
  'readme_assets/',
  'docs/',
  '.kiro/',
  '.amazonq/',
];
const EXCLUDE_EXACT = new Set([
  '.gitlab-ci.yml',
  'DEVELOPMENT_GUIDE.md',
]);
const EXCLUDE_EXT = new Set(['.mp4']);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.woff', '.woff2', '.ttf', '.otf',
]);

function isExcluded(relPath) {
  if (EXCLUDE_EXACT.has(relPath)) return true;
  if (EXCLUDE_PREFIXES.some((p) => relPath.startsWith(p))) return true;
  if (EXCLUDE_EXT.has(path.extname(relPath).toLowerCase())) return true;
  return false;
}

function listTrackedFiles() {
  // Use git so we honour .gitignore and never pick up node_modules/build output.
  const out = execSync('git ls-files', { cwd: SUBMODULE_DIR, encoding: 'utf8' });
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

function main() {
  const submoduleReady =
    fs.existsSync(path.join(SUBMODULE_DIR, '.git')) ||
    fs.existsSync(path.join(SUBMODULE_DIR, 'frontend'));

  // The submodule uses an SSH .gitmodules URL, so environments without git SSH
  // auth (e.g. CI that only vends AWS creds) may not have it checked out. Rather
  // than bricking the build, emit an EMPTY manifest and warn. Both consumers are
  // safe with empty data: seed-template.ts writes 0 files, and prompts.ts joins
  // an empty deps array to ''. The GenAIIC-template toggle simply seeds nothing
  // in that build. CI's build job sets GIT_SUBMODULE_STRATEGY=recursive +
  // GIT_SUBMODULE_FORCE_HTTPS so it normally DOES get the real content.
  if (!submoduleReady) {
    console.warn(
      `⚠️  react-starter-pack submodule not found at ${SUBMODULE_DIR}. ` +
        `Emitting an EMPTY template manifest. For the GenAIIC template seed run: ` +
        `git submodule update --init --recursive`,
    );
    writeManifest({}, { frontend: [], backend: [] });
    return;
  }

  const files = listTrackedFiles().filter((f) => !isExcluded(f));

  if (files.length === 0) {
    console.warn(
      '⚠️  No files found to seed from the react-starter-pack submodule. ' +
        'Emitting an EMPTY template manifest.',
    );
    writeManifest({}, { frontend: [], backend: [] });
    return;
  }

  /** @type {Record<string, { content: string; encoding: 'utf8' | 'base64' }>} */
  const manifest = {};
  let textCount = 0;
  let binCount = 0;

  for (const rel of files) {
    const abs = path.join(SUBMODULE_DIR, rel);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // tracked but missing (e.g. nested submodule) — skip
    }
    if (!stat.isFile()) continue;

    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      manifest[rel] = { content: fs.readFileSync(abs).toString('base64'), encoding: 'base64' };
      binCount++;
    } else {
      manifest[rel] = { content: fs.readFileSync(abs, 'utf8'), encoding: 'utf8' };
      textCount++;
    }
  }

  // Derive the dependency lists straight from the seeded package.json files, so
  // the system prompt can tell the agent exactly what is available WITHOUT a
  // hardcoded list (which drifts) and without needing a file-read capability the
  // agent does not have. Same source as the seed itself → can never drift.
  function depsFrom(relPath) {
    const file = manifest[relPath];
    if (!file || file.encoding !== 'utf8') return [];
    try {
      const pkg = JSON.parse(file.content);
      return Object.keys(pkg.dependencies ?? {}).sort();
    } catch {
      return [];
    }
  }
  const templateDeps = {
    frontend: depsFrom('frontend/package.json'),
    backend: depsFrom('backend/functions/package.json'),
  };

  writeManifest(manifest, templateDeps, { textCount, binCount });
}

/**
 * Serialize the manifest + derived deps to the generated TS module. Shared by
 * the normal path and the empty-fallback path so the emitted file shape is
 * identical (an empty manifest is just `files: {}` and empty deps arrays).
 *
 * @param {Record<string, { content: string; encoding: 'utf8' | 'base64' }>} manifest
 * @param {{ frontend: string[]; backend: string[] }} templateDeps
 * @param {{ textCount?: number; binCount?: number }} [counts]
 */
function writeManifest(manifest, templateDeps, counts = {}) {
  const banner =
    '// AUTO-GENERATED by generate-template-manifest.cjs — DO NOT EDIT.\n' +
    '// Source: react-starter-pack submodule. Regenerated at build time.\n';

  const body =
    banner +
    '\nexport interface TemplateFile {\n' +
    '  content: string;\n' +
    "  encoding: 'utf8' | 'base64';\n" +
    '}\n\n' +
    'export interface TemplateManifest {\n' +
    '  /** Directory under the sandbox workdir to seed into (empty = workdir root). */\n' +
    '  root: string;\n' +
    '  files: Record<string, TemplateFile>;\n' +
    '}\n\n' +
    'export const RSP_TEMPLATE: TemplateManifest = ' +
    JSON.stringify({ root: '', files: manifest }) +
    ' as const;\n\n' +
    '/** Runtime dependencies declared in the seeded package.json files. */\n' +
    'export const RSP_TEMPLATE_DEPS: { frontend: string[]; backend: string[] } = ' +
    JSON.stringify(templateDeps) +
    ' as const;\n';

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, body, 'utf8');

  const bytes = Buffer.byteLength(body, 'utf8');
  const { textCount = 0, binCount = 0 } = counts;
  console.log(
    `🔧 Generated rsp-manifest.ts: ${textCount} text + ${binCount} binary files ` +
      `(${(bytes / 1024).toFixed(0)} KB module); ` +
      `deps: ${templateDeps.frontend.length} frontend + ${templateDeps.backend.length} backend`,
  );
}

main();

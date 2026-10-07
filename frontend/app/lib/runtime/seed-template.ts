import * as nodePath from 'node:path';
import type { RuntimeConnection } from '~/lib/runtime/types';
import { RSP_TEMPLATE, type TemplateManifest } from '~/lib/templates/rsp-manifest';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('TemplateSeeder');

export interface SeedResult {
  written: number;
  failed: number;
  total: number;
}

/**
 * Seed the sandbox workdir with a project template over the fs API.
 *
 * This is what the "Enable GenAIIC Template" toggle actually does. The template
 * (the react-starter-pack tree) is bundled with the frontend at build time
 * (see generate-template-manifest.cjs) and written into the container here at
 * runtime — deliberately NOT baked into the Docker image, so updating the
 * submodule is enough and no image rebuild is needed.
 *
 * Idempotent per file: writing the same content twice is harmless, so a retry
 * of a partially-seeded workdir is safe. One failed file does not abort the
 * rest — more files on disk can only help, and the caller surfaces the count.
 */
export async function seedTemplate(
  conn: RuntimeConnection,
  manifest: TemplateManifest = RSP_TEMPLATE,
): Promise<SeedResult> {
  const entries = Object.entries(manifest.files);
  const base = manifest.root ? manifest.root.replace(/\/+$/g, '') : '';

  // Collect every parent directory once so each is created before its files.
  const dirs = new Set<string>();
  for (const [rel] of entries) {
    const full = base ? `${base}/${rel}` : rel;
    let dir = nodePath.dirname(full).replace(/\/+$/g, '');
    while (dir && dir !== '.' && !dirs.has(dir)) {
      dirs.add(dir);
      dir = nodePath.dirname(dir).replace(/\/+$/g, '');
    }
  }

  // Shallowest first so a parent exists before its children.
  const orderedDirs = Array.from(dirs).sort((a, b) => a.split('/').length - b.split('/').length);
  for (const dir of orderedDirs) {
    try {
      await conn.request({ type: 'fs:mkdir:req', payload: { path: dir } });
    } catch (err) {
      // Non-fatal: the directory may already exist, and the write below is what
      // decides whether seeding a file worked.
      logger.debug(`mkdir ${dir} failed (continuing):`, err);
    }
  }

  let written = 0;
  let failed = 0;

  for (const [rel, file] of entries) {
    const full = base ? `${base}/${rel}` : rel;
    try {
      await conn.request({
        type: 'fs:write:req',
        payload: { path: full, content: file.content, encoding: file.encoding },
      });
      written++;
    } catch (err) {
      failed++;
      logger.warn(`Failed to seed ${full}:`, err);
    }
  }

  logger.info(`Template seeded: ${written}/${entries.length} files (${failed} failed)`);
  return { written, failed, total: entries.length };
}

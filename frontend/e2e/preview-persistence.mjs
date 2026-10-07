/**
 * Regression guard: a follow-up prompt must not destroy a working preview.
 *
 * `addArtifact` used to call `previewsStore.reset()` on every new artifact, which
 * emptied `previews`. The container's port detector emits `port:open:event` only on
 * the transition INTO the listening set, so a dev server that was already up was
 * never re-announced — the pane sat on "Building your project..." forever in front
 * of an app that was serving fine. Measured at 178s stuck, zero recovery.
 *
 * Builds a project, waits for a real preview, sends a follow-up prompt, then samples
 * the pane for three minutes. Fails if the preview ever goes missing and stays
 * missing, or if it is not live at the end.
 *
 * Manual/CI-optional, like `live-coediting.mjs`: it needs a deployed environment and
 * a real account, so it is not part of `pnpm test`.
 *
 * Usage:
 *   BV_BASE_URL=https://<dist>.cloudfront.net \
 *   BV_OWNER_EMAIL=... BV_OWNER_PASSWORD=... \
 *   BV_OUT_DIR=/tmp/bv-preview-check \
 *   node frontend/e2e/preview-persistence.mjs
 *
 * Exit 0 means the preview survived. The JSON in `probe.json` is the full record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BV_BASE_URL;
const OUT = process.env.BV_OUT_DIR || '/tmp/bv-preview-probe';
const EMAIL = process.env.BV_OWNER_EMAIL;
const PASSWORD = process.env.BV_OWNER_PASSWORD;

fs.mkdirSync(OUT, { recursive: true });

const startedAt = Date.now();
const log = (m) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${m}`);

const shot = (page, name) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), timeout: 15_000 }).catch(() => {});

/** Read what the Preview pane is actually showing. */
function readPreviewState(page) {
  return page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    const spinner = [...document.querySelectorAll('p')].find((p) =>
      (p.textContent || '').includes('Building your project'),
    );
    const addressBar = document.querySelector('input[type="text"]');

    return {
      hasIframe: Boolean(iframe),
      iframeSrc: iframe?.getAttribute('src') ?? null,
      showsSpinner: Boolean(spinner),
      addressBar: addressBar?.value ?? null,
    };
  });
}

function clickByText(page, text) {
  return page.evaluate((needle) => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find(
      (c) => (c.textContent || '').trim().includes(needle) && !c.disabled,
    );
    el?.click();
    return Boolean(el);
  }, text);
}

async function waitForPreview(page, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const state = await readPreviewState(page);

    if (state.hasIframe && state.iframeSrc) {
      return state;
    }

    await page.waitForTimeout
      ? await page.waitForTimeout(2000)
      : await new Promise((r) => setTimeout(r, 2000));
  }

  return readPreviewState(page);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

// Capture every port event the client receives, and every previews mutation.
await page.addInitScript(() => {
  window.__PORT_EVENTS__ = [];
  const OriginalWebSocket = window.WebSocket;
  window.WebSocket = function (...args) {
    const ws = new OriginalWebSocket(...args);
    ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string' && event.data.includes('port:')) {
        try {
          const msg = JSON.parse(event.data);
          if (String(msg.type || '').startsWith('port:')) {
            window.__PORT_EVENTS__.push({ t: Date.now(), type: msg.type, payload: msg.payload });
          }
        } catch {}
      }
    });
    return ws;
  };
  window.WebSocket.prototype = OriginalWebSocket.prototype;
  Object.assign(window.WebSocket, OriginalWebSocket);
});

const result = {};

try {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForSelector('input[name="username"]', { timeout: 20_000 });
  await page.fill('input[name="username"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.evaluate(() => {
    [...document.querySelectorAll('button')].find((b) => /sign\s?in/i.test(b.textContent || ''))?.click();
  });
  await page.waitForFunction(() => !document.querySelector('input[name="password"]'), { timeout: 45_000 });
  log('signed in');

  const prompt = await page.waitForSelector('textarea', { timeout: 20_000 });
  await prompt.click();
  await prompt.fill(
    'Create a tiny vite site: index.html with an <h1>Preview Probe</h1> linking styles.css, ' +
      'and styles.css setting body background to lightblue. Serve it with vite on 0.0.0.0.',
  );
  await page.keyboard.press('Enter');
  log('first prompt sent');

  await page.waitForURL(/\/chat\//, { timeout: 90_000 }).catch(() => {});
  await clickByText(page, 'Preview');

  result.previewAfterFirstTurn = await waitForPreview(page, 300_000);
  log(`preview after first turn: ${JSON.stringify(result.previewAfterFirstTurn)}`);
  await shot(page, '01-preview-after-first-turn');

  result.portEventsAfterFirstTurn = await page.evaluate(() => window.__PORT_EVENTS__ ?? []);

  // ── The thing under test: a follow-up turn ──────────────────────────
  log('sending a FOLLOW-UP prompt (the case from the screenshot)');
  const followUp = await page.waitForSelector('textarea', { timeout: 20_000 });
  await followUp.click();
  await followUp.fill('turn this red please');
  await page.keyboard.press('Enter');

  // Sample the preview pane every 2s for 3 minutes so we see it die and whether
  // it ever comes back.
  const samples = [];
  const deadline = Date.now() + 180_000;

  while (Date.now() < deadline) {
    const state = await readPreviewState(page);
    samples.push({ at: ((Date.now() - startedAt) / 1000).toFixed(1), ...state });
    await page.waitForTimeout(2000);
  }

  result.samplesDuringFollowUp = samples;
  result.previewAfterFollowUp = await readPreviewState(page);
  result.portEventsAfterFollowUp = await page.evaluate(() => window.__PORT_EVENTS__ ?? []);
  await shot(page, '02-preview-after-follow-up');

  const spinnerSamples = samples.filter((s) => s.showsSpinner).length;
  result.verdict = {
    previewWorkedBefore: Boolean(result.previewAfterFirstTurn.iframeSrc),
    previewStuckAfter: result.previewAfterFollowUp.showsSpinner,
    secondsShowingSpinner: spinnerSamples * 2,
    portEventCountBefore: result.portEventsAfterFirstTurn.length,
    portEventCountAfter: result.portEventsAfterFollowUp.length,
    newPortEventsDuringFollowUp:
      result.portEventsAfterFollowUp.length - result.portEventsAfterFirstTurn.length,
  };
  log(`VERDICT ${JSON.stringify(result.verdict, null, 2)}`);

  // A brief blank while the iframe reloads is acceptable; a pane that is still
  // spinning at the end, or spent most of the turn spinning, is the regression.
  const SPINNER_BUDGET_SECONDS = 20;

  for (const [condition, message] of [
    [result.verdict.previewWorkedBefore, 'no preview before the follow-up, so this run proves nothing'],
    [!result.verdict.previewStuckAfter, 'preview was still showing "Building your project..." at the end'],
    [
      result.verdict.secondsShowingSpinner <= SPINNER_BUDGET_SECONDS,
      `preview spent ${result.verdict.secondsShowingSpinner}s spinning during the follow-up ` +
        `(budget ${SPINNER_BUDGET_SECONDS}s)`,
    ],
    [Boolean(result.previewAfterFollowUp.iframeSrc), 'preview iframe has no src after the follow-up'],
  ]) {
    if (!condition) {
      throw new Error(message);
    }
  }

  log('preview survived the follow-up turn');
} catch (error) {
  result.error = error.message;
  log(`FAILED: ${error.message}`);
  await shot(page, 'failure');
} finally {
  fs.writeFileSync(path.join(OUT, 'probe.json'), JSON.stringify(result, null, 2));
  await context.close();
  await browser.close();
  process.exit(result.error ? 1 : 0);
}

/**
 * Does the preview actually SHOW each change a prompt asks for?
 *
 * Goes further than `preview-persistence.mjs`, which proves the iframe exists and
 * has a src — not the same as the app being visible or current. This reads INSIDE
 * the preview iframe (same origin as the app, so `contentDocument` is readable) and
 * asserts the rendered page reflects each prompt.
 *
 * Written because `preview-persistence.mjs` passed while the preview was a full turn
 * behind: the file landed on disk, the editor showed it, and the iframe kept serving
 * the previous page. A static site has no Vite HMR client in it, so nothing asked the
 * iframe to refresh; the change only appeared when the NEXT artifact happened to bump
 * the reload key. Two changes in a row is the shortest sequence that catches it —
 * with one, the reload for turn N+1 hides the staleness of turn N.
 *
 * Manual/CI-optional: needs a deployed environment and a real account, so it is not
 * part of `pnpm test`.
 *
 * Usage:
 *   BV_BASE_URL=https://<dist>.cloudfront.net \
 *   BV_OWNER_EMAIL=... BV_OWNER_PASSWORD=... \
 *   BV_OUT_DIR=/tmp/bv-preview-updates \
 *   node frontend/e2e/preview-updates.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.BV_BASE_URL;
const OUT = process.env.BV_OUT_DIR || '/tmp/bv-preview-ui';
const SHOTS = path.join(OUT, 'shots');
const EMAIL = process.env.BV_OWNER_EMAIL;
const PASSWORD = process.env.BV_OWNER_PASSWORD;

fs.mkdirSync(SHOTS, { recursive: true });

const startedAt = Date.now();
const log = (m) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${m}`);
const shot = (page, name) =>
  page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 20_000 }).catch((e) => {
    log(`screenshot skipped (${name}): ${e.message.split('\n')[0]}`);
  });

function clickByText(page, text) {
  return page.evaluate((needle) => {
    const el = [...document.querySelectorAll('button, a, [role="button"]')].find(
      (c) => (c.textContent || '').trim().includes(needle) && !c.disabled,
    );
    el?.click();
    return Boolean(el);
  }, text);
}

/** What the pane is showing, plus what the app inside the iframe renders. */
function readPane(page) {
  return page.evaluate(() => {
    const iframe = document.querySelector('iframe');
    const spinner = [...document.querySelectorAll('p')].some((p) =>
      (p.textContent || '').includes('Building your project'),
    );

    let rendered = null;

    try {
      const doc = iframe?.contentDocument;

      if (doc?.body) {
        const h1 = doc.querySelector('h1');
        rendered = {
          bodyBackground: doc.defaultView.getComputedStyle(doc.body).backgroundColor,
          heading: h1?.textContent?.trim() ?? null,
          bodyTextLength: (doc.body.innerText || '').trim().length,
        };
      }
    } catch (err) {
      rendered = { error: String(err.message || err) };
    }

    return {
      hasIframe: Boolean(iframe),
      iframeSrc: iframe?.getAttribute('src') ?? null,
      showsSpinner: spinner,
      rendered,
    };
  });
}

/**
 * Poll until the app inside the iframe satisfies `isReady`.
 *
 * The predicate matters: an earlier version of this returned as soon as the body
 * had any text, which meant it happily returned the PREVIOUS turn's page and
 * reported the new change as missing. Waiting for the specific change is the only
 * way to tell "the preview did not update" from "the app has not rebuilt yet".
 */
async function waitForRenderedApp(page, timeout, isReady = (r) => r.bodyTextLength > 0) {
  const deadline = Date.now() + timeout;
  let last = null;

  while (Date.now() < deadline) {
    last = await readPane(page);

    if (last.hasIframe && last.rendered && !last.rendered.error && isReady(last.rendered)) {
      return last;
    }

    await page.waitForTimeout(2500);
  }

  return last;
}

/** rgb() form of a red-ish background; colour names come back computed. */
const isRedBackground = (c) =>
  /rgba?\(\s*(1[6-9]\d|2\d\d|255)\s*,\s*([0-9]|[0-5]\d)\s*,\s*([0-9]|[0-5]\d)/.test(c || '');

/**
 * Send a prompt and watch the pane for the whole turn.
 *
 * Returns the worst thing seen, not just the end state: a preview that vanishes
 * mid-turn and silently comes back is still the bug if it stays gone for long.
 */
async function sendPromptAndWatch(page, text, watchMs) {
  const box = await page.waitForSelector('textarea', { timeout: 20_000 });
  await box.click();
  await box.fill(text);
  await page.keyboard.press('Enter');
  log(`prompt sent: "${text}"`);

  const samples = [];
  const deadline = Date.now() + watchMs;

  while (Date.now() < deadline) {
    samples.push({ at: ((Date.now() - startedAt) / 1000).toFixed(1), ...(await readPane(page)) });
    await page.waitForTimeout(2500);
  }

  return samples;
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: path.join(OUT, 'videos'), size: { width: 1440, height: 900 } },
});
const page = await context.newPage();

const consoleSink = path.join(OUT, 'console.log');
page.on('console', (m) => {
  if (m.type() === 'error') fs.appendFileSync(consoleSink, `${m.text()}\n`);
});
page.on('pageerror', (e) => fs.appendFileSync(consoleSink, `PAGEERROR ${e.message}\n`));

const proof = { steps: [] };

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
  await shot(page, '01-signed-in');

  // ── Turn 1: build it ──────────────────────────────────────────────
  const box = await page.waitForSelector('textarea', { timeout: 20_000 });
  await box.click();
  await box.fill(
    'Create a vite site with exactly two files: index.html containing <h1>Preview Check</h1> and ' +
      'linking styles.css, and styles.css setting the body background to lightblue. Serve it with vite.',
  );
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/chat\//, { timeout: 90_000 }).catch(() => {});
  log('build prompt sent');

  await clickByText(page, 'Preview');
  proof.afterBuild = await waitForRenderedApp(page, 300_000, (r) => Boolean(r.heading));
  log(`after build: ${JSON.stringify(proof.afterBuild.rendered)}`);
  await shot(page, '02-preview-after-build');
  proof.chatUrl = page.url();

  // ── Turn 2: first follow-up — the case from the screenshot ────────
  proof.steps.push({
    name: 'follow-up 1: make it red',
    samples: await sendPromptAndWatch(page, 'make the background red please', 90_000),
  });
  proof.afterRed = await waitForRenderedApp(page, 240_000, (r) => isRedBackground(r.bodyBackground));
  log(`after "red": ${JSON.stringify(proof.afterRed.rendered)}`);
  await shot(page, '03-preview-after-red');

  // ── Turn 3: a second follow-up, to prove it is not a one-off ──────
  proof.steps.push({
    name: 'follow-up 2: change the heading',
    samples: await sendPromptAndWatch(
      page,
      'change the h1 heading text to Second Change Works and keep the red background',
      90_000,
    ),
  });
  proof.afterHeading = await waitForRenderedApp(page, 240_000, (r) =>
    (r.heading || '').includes('Second Change Works'),
  );
  log(`after heading change: ${JSON.stringify(proof.afterHeading.rendered)}`);
  await shot(page, '04-preview-after-heading-change');

  // ── Tab toggle: Code → Preview must not lose the preview ──────────
  await page.evaluate(() => {
    // The tab, not the artifact card's "Click to open Workbench", which the same
    // text match would otherwise hit and collapse the whole workbench.
    const tab = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === 'Code',
    );
    tab?.click();
  });
  await page.waitForTimeout(2500);
  await shot(page, '05-code-tab');
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll('button')].find(
      (b) => (b.textContent || '').trim() === 'Preview',
    );
    tab?.click();
  });
  await page.waitForTimeout(4000);
  proof.afterTabToggle = await readPane(page);
  log(`after tab toggle: spinner=${proof.afterTabToggle.showsSpinner} src=${Boolean(proof.afterTabToggle.iframeSrc)}`);
  await shot(page, '06-preview-after-tab-toggle');

  // ── Verdict ──────────────────────────────────────────────────────
  const allSamples = proof.steps.flatMap((s) => s.samples);
  const spinnerSamples = allSamples.filter((s) => s.showsSpinner);

  proof.verdict = {
    builtAndRendered: proof.afterBuild.rendered?.bodyTextLength > 0,
    headingAfterBuild: proof.afterBuild.rendered?.heading,
    backgroundAfterBuild: proof.afterBuild.rendered?.bodyBackground,
    backgroundAfterRed: proof.afterRed.rendered?.bodyBackground,
    headingAfterChange: proof.afterHeading.rendered?.heading,
    totalSamplesAcrossFollowUps: allSamples.length,
    spinnerSamples: spinnerSamples.length,
    secondsSpinning: spinnerSamples.length * 2.5,
    previewLiveAtEnd: Boolean(proof.afterTabToggle.iframeSrc) && !proof.afterTabToggle.showsSpinner,
  };

  proof.verdict.backgroundActuallyTurnedRed = isRedBackground(proof.afterRed.rendered?.bodyBackground);
  proof.verdict.headingActuallyChanged =
    (proof.afterHeading.rendered?.heading || '').includes('Second Change Works');

  log(`VERDICT ${JSON.stringify(proof.verdict, null, 2)}`);

  const SPINNER_BUDGET = 25;

  for (const [ok, message] of [
    [proof.verdict.builtAndRendered, 'the preview never rendered the app after the initial build'],
    [proof.verdict.backgroundActuallyTurnedRed, `background did not turn red (got ${proof.afterRed.rendered?.bodyBackground})`],
    [proof.verdict.headingActuallyChanged, `heading did not change (got ${proof.afterHeading.rendered?.heading})`],
    [
      proof.verdict.secondsSpinning <= SPINNER_BUDGET,
      `preview spent ${proof.verdict.secondsSpinning}s on the spinner across the follow-ups (budget ${SPINNER_BUDGET}s)`,
    ],
    [proof.verdict.previewLiveAtEnd, 'preview was not live after toggling Code and back to Preview'],
  ]) {
    if (!ok) throw new Error(message);
  }

  log('ALL CHECKS PASSED — preview survives follow-ups and shows each change');
} catch (error) {
  proof.error = error.message;
  log(`FAILED: ${error.message}`);
  await shot(page, 'failure');
} finally {
  const video = page.video();
  await context.close();

  if (video) {
    fs.copyFileSync(await video.path(), path.join(OUT, 'preview-ui-check.webm'));
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(proof, null, 2));
  process.exit(proof.error ? 1 : 0);
}

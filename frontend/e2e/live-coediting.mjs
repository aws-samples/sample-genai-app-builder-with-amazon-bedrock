/**
 * End-to-end proof of live co-editing against a deployed environment.
 *
 * Drives two real browser profiles as two different Cognito users: the owner
 * builds a project, goes live and mints an invite; the guest redeems the link,
 * and both then type into the same file. Asserts the guest lands in the owner's
 * exact sandbox session and that edits propagate in both directions. Records a
 * video per browser plus a screenshot at every step, so a run doubles as the
 * artefact we share.
 *
 * This is a manual/CI-optional harness, not part of `pnpm test` — it needs a
 * deployed environment and two real accounts. Playwright is not a repo
 * dependency; run it with `npx playwright@1.61 ...` or a global install.
 *
 * Usage:
 *   BV_BASE_URL=https://<dist>.cloudfront.net \
 *   BV_OWNER_EMAIL=... BV_OWNER_PASSWORD=... \
 *   BV_GUEST_EMAIL=... BV_GUEST_PASSWORD=... \
 *   BV_OUT_DIR=/tmp/bv-coedit-proof \
 *   node frontend/e2e/live-coediting.mjs
 *
 * Exit code 0 means every assertion held. The JSON on the final `PROOF` line is
 * the machine-readable result.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = requireEnv('BV_BASE_URL');
const OWNER = { email: requireEnv('BV_OWNER_EMAIL'), password: requireEnv('BV_OWNER_PASSWORD') };
const GUEST = { email: requireEnv('BV_GUEST_EMAIL'), password: requireEnv('BV_GUEST_PASSWORD') };
const OUT = process.env.BV_OUT_DIR || '/tmp/bv-coedit-proof';
const SHOTS = path.join(OUT, 'shots');
const VIDEOS = path.join(OUT, 'videos');

/** Marker the guest types; the owner's editor must show it for the test to pass. */
const GUEST_MARKER = 'LIVE CO-EDIT: guest turned it RED';
const OWNER_MARKER = 'owner replies: seen in real time';

/**
 * The prompt the COLLABORATOR sends. The owner's chat must show it without a
 * reload — that is the difference between a shared conversation and two people
 * each talking to their own copy.
 */
const GUEST_PROMPT = 'Change the h1 text to Collaborator Was Here and keep everything else the same.';
/**
 * The assistant's answer is free text, so there is no needle to match on that
 * would not also match the prompt. Count assistant rows instead: a reply the
 * owner did not have before is a reply that reached them live.
 */

/** A cold sandbox can take well over a minute to boot, so waits are generous. */
const BOOT_TIMEOUT = 360_000;
const SYNC_TIMEOUT = 60_000;

function requireEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

const startedAt = Date.now();
const log = (message) => console.log(`[${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}`);

async function shot(page, name) {
  try {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15_000 });
  } catch (error) {
    // a visible preview iframe animates forever, so a screenshot can time out;
    // losing one frame must not fail the run
    log(`screenshot skipped (${name}): ${error.message.split('\n')[0]}`);
  }
}

/** Click the first enabled button/link whose visible text contains `text`. */
function clickByText(page, text) {
  return page.evaluate((needle) => {
    const candidates = [...document.querySelectorAll('button, a, [role="button"]')];
    const target = candidates.find((el) => (el.textContent || '').trim().includes(needle) && !el.disabled);
    target?.click();

    return Boolean(target);
  }, text);
}

async function signIn(page, user, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  try {
    await page.waitForSelector('input[name="username"]', { timeout: 15_000 });
  } catch {
    log(`no sign-in form for ${user.email}; already authenticated`);
    return;
  }

  await page.fill('input[name="username"]', user.email);
  await page.fill('input[name="password"]', user.password);
  await page.evaluate(() => {
    const button = [...document.querySelectorAll('button')].find((el) => /sign\s?in/i.test(el.textContent || ''));
    button?.click();
  });
  await page.waitForFunction(() => !document.querySelector('input[name="password"]'), { timeout: 45_000 });
  log(`signed in: ${user.email}`);
}

/** Resolve once the workbench file tree holds real project files. */
function waitForFiles(page, timeout) {
  return page.waitForFunction(() => /\.(html|css|jsx?|tsx?|json)\b/.test(document.body.innerText || ''), {
    timeout,
    polling: 1000,
  });
}

/**
 * Open a file from the tree by exact name. Rows render as leaf elements inside a
 * button, so the clickable ancestor is what we need.
 */
function openFile(page, name) {
  return page.evaluate((needle) => {
    const leaves = [...document.querySelectorAll('div, span')].filter(
      (el) => el.childElementCount === 0 && (el.textContent || '').trim() === needle,
    );

    for (const leaf of leaves) {
      const button = leaf.closest('button');

      if (button) {
        button.click();
        return true;
      }
    }

    return false;
  }, name);
}

/**
 * Open a file, retrying until the tree holds it.
 *
 * The guest's tree renders a beat after they join, and the co-edit step runs
 * immediately after the chat-parity check — so a single attempt races the render
 * and fails for a reason that has nothing to do with sync.
 */
async function openFileWhenReady(page, name, timeout = 30_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await openFile(page, name)) {
      return;
    }

    await clickByText(page, 'Code');
    await page.waitForTimeout(1000);
  }

  throw new Error(`could not open ${name} within ${timeout}ms`);
}

function listFiles(page, pattern) {
  return page.evaluate((source) => {
    const regex = new RegExp(source);
    const names = new Set();

    for (const el of document.querySelectorAll('div, span')) {
      const text = (el.textContent || '').trim();

      if (el.childElementCount === 0 && regex.test(text) && el.closest('button')) {
        names.add(text);
      }
    }

    return [...names].sort();
  }, pattern.source);
}

/**
 * The text of every user-authored message in the chat pane.
 *
 * Scoped to the message rows — each carries a user avatar — rather than reading
 * the page body, because the same string can appear in an open file (the owner's
 * prompt asks for `<h1>Team Demo</h1>`, which is then in index.html too) and that
 * would make a chat-parity check pass for the wrong reason.
 */
function readUserMessages(page) {
  return page.evaluate(() => {
    const avatars = [...document.querySelectorAll('[class*="i-ph:user-fill"]')];
    const rows = avatars.map((avatar) => avatar.closest('.gap-4')).filter(Boolean);

    return rows.map((row) => (row.textContent || '').trim()).filter(Boolean);
  });
}

/**
 * How many assistant replies the chat pane is showing.
 *
 * Counted rather than matched on text: the model's wording is not fixed, and any
 * needle short enough to be stable also appears in the prompt that asked for it —
 * which would let this pass on the user's own message.
 */
function countAssistantMessages(page) {
  return page.evaluate(() => {
    // Only user rows render an avatar, so a message row without one is the
    // assistant's. Selecting on the row's own layout classes rather than on an
    // avatar is what makes assistant rows findable at all.
    const rows = [...document.querySelectorAll('div.gap-4.p-6')];

    return rows.filter((row) => !row.querySelector('[class*="i-ph:user-fill"]')).length;
  });
}

/**
 * Bring the newest message into view before a screenshot.
 *
 * The assertions read the DOM, which does not care what is scrolled into the
 * 720px viewport — but a screenshot showing only the first prompt is not evidence
 * of the last one, and these images are the artefact we share.
 */
async function scrollChatToLatest(page) {
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('div.gap-4.p-6')];
    rows.at(-1)?.scrollIntoView({ block: 'end' });
  });
  await page.waitForTimeout(600);
}

/** Resolve true once a user message in the chat pane contains `needle`. */
async function waitForChatToContain(page, needle, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const messages = await readUserMessages(page);

    if (messages.some((message) => message.includes(needle))) {
      return true;
    }

    await page.waitForTimeout(1000);
  }

  return false;
}

/**
 * Wait for `marker` to appear in the editor itself.
 *
 * Deliberately not a `document.body.innerText` check: the workbench reveals the
 * preview when the dev server opens a port, which unmounts the editor and would
 * fail this assertion for a reason that has nothing to do with sync. Re-select
 * Code and re-open the shared file first, then read CodeMirror's own content.
 */
async function waitForMarkerInEditor(page, marker, file, timeout) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const seen = await page.evaluate((needle) => {
      const editor = document.querySelector('.cm-content');
      return Boolean(editor && (editor.innerText || '').includes(needle));
    }, marker);

    if (seen) {
      return;
    }

    // the preview may have stolen the tab; put the file back in front
    await clickByText(page, 'Code');
    await openFile(page, file);
    await page.waitForTimeout(1000);
  }

  throw new Error(`"${marker}" never reached the editor within ${timeout}ms`);
}

/**
 * Make the workbench the front pane.
 *
 * The editor can be mounted but overlaid by the chat — the artifact card is what
 * intercepts the click — and that is a layout race, not a sync failure. The card's
 * own "open Workbench" affordance is the reliable way through.
 */
async function openWorkbench(page) {
  await clickByText(page, 'Click to open Workbench').catch(() => {});
  await clickByText(page, 'Code');
  await page.waitForTimeout(800);
}

/**
 * Type at the end of the open document, going through the real input pipeline.
 *
 * Focused programmatically rather than by clicking: a click is aimed at a point
 * and fails when another pane covers it, whereas the keystrokes that follow are
 * the thing under test and reach CodeMirror either way.
 */
async function appendInEditor(page, text) {
  const focused = await page.evaluate(() => {
    const editor = document.querySelector('.cm-content');
    editor?.focus();

    return document.activeElement === editor;
  });

  if (!focused) {
    await page.click('.cm-content', { timeout: 15_000 });
  }

  await page.keyboard.press('ControlOrMeta+ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type(text, { delay: 35 });
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(VIDEOS, { recursive: true });

  const browser = await chromium.launch({ headless: process.env.BV_HEADED !== '1' });
  const newContext = () =>
    browser.newContext({
      viewport: { width: 1280, height: 720 },
      recordVideo: { dir: VIDEOS, size: { width: 1280, height: 720 } },
      permissions: ['clipboard-read', 'clipboard-write'],
    });

  // both contexts up front so the two videos share a timeline
  const ownerContext = await newContext();
  const guestContext = await newContext();
  const owner = await ownerContext.newPage();
  const guest = await guestContext.newPage();

  for (const [page, who] of [
    [owner, 'owner'],
    [guest, 'guest'],
  ]) {
    const sink = path.join(OUT, `${who}-console.log`);
    page.on('console', (message) => {
      if (message.type() === 'error') {
        fs.appendFileSync(sink, `${message.text()}\n`);
      }
    });
    page.on('pageerror', (error) => fs.appendFileSync(sink, `PAGEERROR ${error.message}\n`));
  }

  const proof = {};

  try {
    await signIn(owner, OWNER, `${BASE}/`);
    await shot(owner, '01-owner-signed-in');

    // Always build a fresh project rather than reusing an existing one. The
    // project id is what an invite shares, and only projects created after the
    // unique-id fix carry a collision-free id — reusing a pre-fix numeric project
    // would not exercise the conversation-sharing path this run is here to prove.
    log('owner building a fresh project from a prompt');

    const prompt = await owner.waitForSelector('textarea', { timeout: 20_000 });
    await prompt.click();
    await prompt.fill(
      'Create a tiny static site with exactly two files: index.html with an <h1>Team Demo</h1> that links ' +
        'styles.css, and styles.css setting body background to lightblue. Serve it with vite. No other files.',
    );
    await owner.keyboard.press('Enter');
    await owner.waitForURL(/\/chat\//, { timeout: 90_000 }).catch(() => log('no /chat/ redirect yet'));
    await waitForFiles(owner, BOOT_TIMEOUT);
    // let the agent's turn land its files before anyone else attaches
    await owner.waitForTimeout(20_000);

    proof.ownerSession = await owner.evaluate(() => window.__SANDBOX_SESSION_ID__);
    await clickByText(owner, 'Code');
    proof.ownerFilesBeforeJoin = await listFiles(owner, /^[\w.-]+\.\w+$/);

    // Capture the owner's first prompt so we can later assert the guest's chat
    // pane shows this same conversation, not one of the guest's own.
    const ownerMessages = await readUserMessages(owner);
    proof.ownerFirstPrompt = ownerMessages[0] || '';
    log(`owner ready in session ${proof.ownerSession}`);
    await shot(owner, '02-owner-project-loaded');

    if (!(await clickByText(owner, 'Go live'))) {
      throw new Error('"Go live" control not found');
    }

    await owner.waitForSelector('[data-testid="live-presence"]', { timeout: 120_000 });
    await shot(owner, '03-owner-live');

    // read the token off the response rather than the clipboard, which reads
    // stale in headless chromium
    const invitePromise = owner.waitForResponse(
      (response) => response.url().includes('/invite') && response.request().method() === 'POST',
      { timeout: 60_000 },
    );

    if (!(await clickByText(owner, 'Invite'))) {
      throw new Error('"Invite" control not found');
    }

    const { token } = await (await invitePromise).json();

    if (!token) {
      throw new Error('invite response carried no token');
    }

    const joinUrl = new URL(owner.url());
    joinUrl.searchParams.set('join', token);
    log('invite minted');
    await shot(owner, '04-owner-invited');

    await signIn(guest, GUEST, joinUrl.toString());

    if (!guest.url().includes('join=')) {
      await guest.goto(joinUrl.toString(), { waitUntil: 'domcontentloaded' });
    }

    await guest.waitForFunction(() => Boolean(window.__SANDBOX_SESSION_ID__), {
      timeout: BOOT_TIMEOUT,
      polling: 1000,
    });
    await waitForFiles(guest, BOOT_TIMEOUT);

    proof.guestSession = await guest.evaluate(() => window.__SANDBOX_SESSION_ID__);
    proof.joinedOwnersContainer = proof.guestSession === proof.ownerSession;
    await clickByText(guest, 'Code');
    log(`guest joined session ${proof.guestSession} (owner's container: ${proof.joinedOwnersContainer})`);
    await shot(guest, '05-guest-joined');

    // Chat parity: the guest must see the OWNER's conversation behind the shared
    // files, not their own. The guest loads it once the invite is redeemed, a
    // beat after first paint, so poll rather than read once.
    const promptNeedle = proof.ownerFirstPrompt.slice(0, 40);
    proof.guestSawOwnerConversation = promptNeedle
      ? await waitForChatToContain(guest, promptNeedle, 30_000)
      : false;
    proof.guestUserMessages = await readUserMessages(guest);
    log(`guest chat shows the owner's conversation: ${proof.guestSawOwnerConversation}`);
    await shot(guest, '05b-guest-chat-parity');

    await owner
      .waitForFunction(() => document.querySelectorAll('[data-testid="presence-avatar"]').length >= 2, {
        timeout: 60_000,
      })
      .catch(() => log("owner never saw the guest's avatar"));
    proof.ownerPresenceAvatars = await owner.$$eval('[data-testid="presence-avatar"]', (els) => els.length);
    await shot(owner, '06-owner-sees-guest-presence');

    const stylesheets = await listFiles(owner, /\.css$/);

    if (stylesheets.length === 0) {
      throw new Error('no stylesheet in the tree to co-edit');
    }

    const sharedFile = stylesheets[0];
    proof.sharedFile = sharedFile;

    for (const page of [owner, guest]) {
      await openWorkbench(page);
      await openFileWhenReady(page, sharedFile);
      await page.waitForSelector('.cm-content', { timeout: 30_000 });
    }

    await owner.waitForTimeout(1500);

    await appendInEditor(guest, `\n\n/* ${GUEST_MARKER} */\nbody { background: red; }\n`);
    await shot(guest, '07-guest-typed-red');

    await waitForMarkerInEditor(owner, GUEST_MARKER, sharedFile, SYNC_TIMEOUT);
    proof.ownerSawGuestEdit = true;
    log("owner's editor received the guest's edit");
    await shot(owner, '08-owner-sees-guest-edit');

    await appendInEditor(owner, `\n/* ${OWNER_MARKER} */\n`);
    await waitForMarkerInEditor(guest, OWNER_MARKER, sharedFile, SYNC_TIMEOUT);
    proof.guestSawOwnerEdit = true;
    log("guest's editor received the owner's edit");
    await shot(guest, '09-guest-sees-owner-edit');

    // ---------------------------------------------------------------------
    // The collaborator drives the conversation, and the owner must see it.
    //
    // This is the assertion that fails if chat is durable but not live: saving
    // to DynamoDB is only read when a project mounts, so a prompt the guest
    // sends would reach the owner on a reload and not before. Nothing here
    // reloads, so passing means it arrived over the live channel.
    // ---------------------------------------------------------------------
    log('guest sends a chat prompt; owner must see it without reloading');
    proof.ownerUrlBeforeGuestPrompt = owner.url();
    proof.ownerAssistantRepliesBefore = await countAssistantMessages(owner);

    await clickByText(guest, 'Code').catch(() => {});

    const guestPrompt = await guest.waitForSelector('textarea', { timeout: 20_000 });
    await guestPrompt.click();
    await guestPrompt.fill(GUEST_PROMPT);
    await guest.keyboard.press('Enter');
    await waitForChatToContain(guest, GUEST_PROMPT, 60_000);
    await scrollChatToLatest(guest);
    await shot(guest, '10a-guest-sent-prompt');

    proof.ownerSawGuestPrompt = await waitForChatToContain(owner, GUEST_PROMPT, SYNC_TIMEOUT);
    proof.ownerUserMessagesAfterGuestPrompt = await readUserMessages(owner);
    // A reload would also make the prompt appear, so record that none happened.
    proof.ownerDidNotReload = owner.url() === proof.ownerUrlBeforeGuestPrompt;
    log(`owner saw the guest's prompt live: ${proof.ownerSawGuestPrompt}`);
    await scrollChatToLatest(owner);
    await shot(owner, '10b-owner-sees-guest-prompt');

    // The assistant's reply lands in the same shared conversation, so the owner
    // should be watching the answer arrive too, not just the question.
    const repliesDeadline = Date.now() + 150_000;
    proof.ownerAssistantRepliesAfter = proof.ownerAssistantRepliesBefore;

    while (Date.now() < repliesDeadline) {
      proof.ownerAssistantRepliesAfter = await countAssistantMessages(owner);

      if (proof.ownerAssistantRepliesAfter > proof.ownerAssistantRepliesBefore) {
        break;
      }

      await owner.waitForTimeout(2000);
    }

    proof.ownerSawAssistantReply =
      proof.ownerAssistantRepliesAfter > proof.ownerAssistantRepliesBefore;
    log(
      `owner assistant replies ${proof.ownerAssistantRepliesBefore} -> ${proof.ownerAssistantRepliesAfter}` +
        ` (saw the reply to the guest: ${proof.ownerSawAssistantReply})`,
    );
    await scrollChatToLatest(owner);
    await shot(owner, '10c-owner-sees-assistant-reply');
    await scrollChatToLatest(guest);
    await shot(guest, '10d-guest-final-chat');

    // One conversation means one slug. Divergence here is the bug where the
    // server never learned the urlId and each side minted its own.
    proof.ownerChatUrl = owner.url();
    proof.guestChatUrl = guest.url();
    proof.sameChatUrl = new URL(proof.ownerChatUrl).pathname === new URL(proof.guestChatUrl).pathname;
    log(`owner ${proof.ownerChatUrl} | guest ${proof.guestChatUrl} | same: ${proof.sameChatUrl}`);

    proof.ownerFilesAfterJoin = await listFiles(owner, /^[\w.-]+\.\w+$/);
    proof.filesAppearedAfterJoin = proof.ownerFilesAfterJoin.filter(
      (file) => !proof.ownerFilesBeforeJoin.includes(file),
    );
    await shot(owner, '10-owner-final');

    // hold the end state so it is readable on the recording
    await owner.waitForTimeout(3000);

    for (const [key, message] of [
      ['joinedOwnersContainer', 'guest did not land in the owner’s container'],
      ['guestSawOwnerConversation', "guest's chat did not show the owner's conversation"],
      ['ownerSawGuestEdit', "owner never received the guest's edit"],
      ['guestSawOwnerEdit', "guest never received the owner's edit"],
      ['ownerSawGuestPrompt', "owner never saw the prompt the guest sent (chat is not live)"],
      ['ownerDidNotReload', 'owner reloaded, so seeing the prompt proves nothing'],
      ['sameChatUrl', 'owner and guest are on different chat URLs for one conversation'],
      ['ownerSawAssistantReply', "owner never saw the assistant's reply to the guest's prompt"],
    ]) {
      if (!proof[key]) {
        throw new Error(message);
      }
    }
  } catch (error) {
    proof.error = error.message;
    log(`FAILED: ${error.message}`);
    await shot(owner, 'failure-owner');
    await shot(guest, 'failure-guest');
  } finally {
    const videos = { owner: owner.video(), guest: guest.video() };
    await ownerContext.close();
    await guestContext.close();

    for (const [who, video] of Object.entries(videos)) {
      if (video) {
        fs.copyFileSync(await video.path(), path.join(OUT, `${who}.webm`));
      }
    }

    await browser.close();
    fs.writeFileSync(path.join(OUT, 'proof.json'), JSON.stringify(proof, null, 2));
    console.log(`PROOF ${JSON.stringify(proof)}`);
    process.exit(proof.error ? 1 : 0);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

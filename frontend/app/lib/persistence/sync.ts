import type { Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import { getProjectsClient, ProjectsApiError } from '~/lib/api/projects-client';
import type { ChatHistoryItem } from './useChatHistory';

const logger = createScopedLogger('ChatSync');

/**
 * Server-backed side of chat persistence.
 *
 * The browser database remains the thing the UI reads and writes synchronously —
 * it is fast, works offline, and every existing caller already depends on its
 * shape. This module mirrors those writes to the API and can read history back,
 * which is what makes a project survive losing a browser, open on a second
 * device, and be visible to someone invited into the session.
 *
 * Everything here is best-effort by design. A server that is unreachable, or a
 * user whose auth has not hydrated yet, must never stop someone editing: local
 * writes have already succeeded by the time these run, and a failed sync is
 * retried the next time the same chat is saved.
 */

/** Projects known to exist server-side this session, to avoid redundant calls. */
const known = new Set<string>();

/** Metadata already sent per project, so a settled slug is not re-sent each turn. */
const sentMeta = new Map<string, string>();

export interface PushItem {
  id: string;
  urlId?: string;
  description?: string;
  messages: Message[];
}

/**
 * Per-project write pressure state.
 *
 * `storeMessageHistory` fires on every message change, so without this a single
 * session sent dozens of full-conversation writes — every message of a project
 * shares one DynamoDB partition key, and that is what exhausted its write capacity
 * and turned saves into 500s.
 */
interface ProjectSync {
  /** Fingerprint of the array the server has acknowledged; unchanged means nothing to send. */
  pushed?: string;
  /** The run currently talking to the server, if any. */
  inFlight?: Promise<void>;
  /** Newest snapshot that arrived while a run was busy or backing off. */
  pending?: PushItem;
  /** Epoch ms before which no attempt should be made, after a rejected save. */
  retryAt?: number;
  /** Consecutive rejected saves, which sets the length of the backoff. */
  failures: number;
  timer?: ReturnType<typeof setTimeout>;
}

const syncState = new Map<string, ProjectSync>();

/** First backoff step after a rejected save; doubles per consecutive failure. */
const RETRY_BASE_MS = 1_000;

/** Ceiling on the backoff, so a long outage still retries at a useful rate. */
const RETRY_MAX_MS = 30_000;

function stateFor(id: string): ProjectSync {
  const existing = syncState.get(id);

  if (existing) {
    return existing;
  }

  const fresh: ProjectSync = { failures: 0 };
  syncState.set(id, fresh);

  return fresh;
}

function isAvailable(): boolean {
  // No API configured means local development against IndexedDB alone.
  return typeof window !== 'undefined' && Boolean(window.ENV?.API_GATEWAY_REST_URL);
}

/**
 * Identity of a conversation as the server holds it.
 *
 * Ids alone are not enough: the assistant's last message grows while it streams,
 * so its content has to be part of the fingerprint or the final version of a reply
 * would never be sent.
 */
function messagesFingerprint(messages: Message[]): string {
  return messages.map((message) => `${message.id}:${lengthOf(message.content)}`).join('|');
}

function lengthOf(content: Message['content']): number {
  return typeof content === 'string' ? content.length : JSON.stringify(content ?? '').length;
}

/**
 * Mirror a chat to the server.
 *
 * Creates the project on first sight — using the id the browser already assigned,
 * so URLs survive the move — then sends the messages. The message write is
 * idempotent server-side, so re-sending the whole array converges rather than
 * duplicating.
 *
 * Three things keep the caller's per-change save from overwhelming a project's
 * DynamoDB partition: an array the server already has is not re-sent, snapshots
 * arriving during a request are coalesced into one follow-up, and a rejected save
 * is retried after a backoff rather than on the next keystroke.
 */
export async function pushChat(item: PushItem): Promise<void> {
  if (!isAvailable() || item.messages.length === 0) {
    return;
  }

  const state = stateFor(item.id);

  // Nothing new to say. Metadata can still have settled since the last push, so
  // that check happens inside the run rather than here.
  if (state.pushed === messagesFingerprint(item.messages) && !metaOutstanding(item)) {
    return;
  }

  // A run is already talking to the server: hand it the newest snapshot instead of
  // opening a second request. A burst of streaming updates then costs one request
  // per round trip rather than one per token.
  if (state.inFlight) {
    state.pending = item;
    return;
  }

  const wait = (state.retryAt ?? 0) - Date.now();

  if (wait > 0) {
    // Still inside the backoff. Hold the snapshot and let the scheduled flush send
    // it, so the last save of a conversation is not lost to a transient failure.
    state.pending = item;
    scheduleFlush(item.id, wait);

    return;
  }

  state.inFlight = run(item.id, item);

  return state.inFlight;
}

/** Drain the newest snapshot for a project, one request at a time. */
async function run(id: string, first: PushItem): Promise<void> {
  const state = stateFor(id);
  let next: PushItem | undefined = first;

  try {
    while (next) {
      const item = next;
      state.pending = undefined;

      if (!(await pushOnce(item))) {
        // Failed and already backed off; the scheduled flush picks it up.
        return;
      }

      next = state.pending;
    }
  } finally {
    state.inFlight = undefined;
  }
}

/** One attempt. Returns false when the message write was rejected. */
async function pushOnce(item: PushItem): Promise<boolean> {
  const state = stateFor(item.id);
  const client = getProjectsClient();

  if (!known.has(item.id)) {
    try {
      await client.create({ id: item.id, urlId: item.urlId, description: item.description });
      known.add(item.id);
      // `create` accepted this metadata, so there is nothing left to patch.
      sentMeta.set(item.id, metaFingerprint(item));
    } catch (err) {
      // A 409 means the project exists and is owned by someone else — the normal
      // answer for an invited collaborator. Their membership is what authorises the
      // append below, so this must fall through rather than abandon their message.
      // Any other failure leaves the project unknown so the next save retries the
      // create.
      if (err instanceof ProjectsApiError && err.status === 409) {
        known.add(item.id);
      } else {
        logger.debug('Could not create the project server-side:', err);
      }
    }
  }

  const fingerprint = messagesFingerprint(item.messages);

  if (state.pushed !== fingerprint) {
    try {
      await client.appendMessages(item.id, item.messages);
      state.pushed = fingerprint;
      state.failures = 0;
      state.retryAt = undefined;
    } catch (err) {
      // Deliberately not surfaced: the user's work is already saved locally and
      // this will be retried, so there is nothing they could act on.
      logger.debug('Could not sync chat to the server:', err);
      backOff(item.id, item, err);

      return false;
    }
  }

  await pushMeta(client, item);

  return true;
}

/**
 * Space out the next attempt after a rejected save.
 *
 * A 429 is the server saying the project's write capacity is spent, and its
 * Retry-After is a better number than any guess, so it wins when present.
 * Otherwise the delay doubles per consecutive failure — which is the difference
 * between riding out a throttle and prolonging it.
 */
function backOff(id: string, item: PushItem, err: unknown): void {
  const state = stateFor(id);
  state.failures++;
  state.pending = item;

  const advised = err instanceof ProjectsApiError ? err.retryAfterMs : undefined;
  const delay = advised ?? Math.min(RETRY_BASE_MS * 2 ** (state.failures - 1), RETRY_MAX_MS);

  state.retryAt = Date.now() + delay;
  scheduleFlush(id, delay);
}

/** Send the held snapshot after `delay`. At most one timer per project. */
function scheduleFlush(id: string, delay: number): void {
  const state = stateFor(id);

  if (state.timer) {
    return;
  }

  state.timer = setTimeout(() => {
    state.timer = undefined;

    const item = state.pending;

    if (!item || state.inFlight) {
      return;
    }

    state.retryAt = undefined;
    state.inFlight = run(id, item);
  }, delay);
}

/** Whether this item carries metadata the server has not been told about yet. */
function metaOutstanding(item: PushItem): boolean {
  if (!item.urlId && !item.description) {
    return false;
  }

  return sentMeta.get(item.id) !== metaFingerprint(item);
}

function metaFingerprint(item: { urlId?: string; description?: string }): string {
  return `${item.urlId ?? ''}|${item.description ?? ''}`;
}

/**
 * Send metadata that did not exist when the project was created.
 *
 * The server-side create happens on a project's first save, which is before the
 * AI has produced an artifact — so there is no slug or title yet, and `create`
 * only ever accepts them once. Both settle a turn later. Without this the server
 * would hold a project with no `urlId` forever, and a collaborator resolving the
 * shared project would get `urlId: undefined`, mint a slug of their own and end
 * up on a different URL from the owner for the same conversation.
 *
 * Skipped once sent, so a settled project costs nothing per turn. Best-effort:
 * only the owner may patch, so a guest's attempt is expected to be refused and
 * must not disturb their message write.
 */
async function pushMeta(
  client: ReturnType<typeof getProjectsClient>,
  item: { id: string; urlId?: string; description?: string },
): Promise<void> {
  if (!item.urlId && !item.description) {
    return;
  }

  const fingerprint = metaFingerprint(item);

  if (sentMeta.get(item.id) === fingerprint) {
    return;
  }

  sentMeta.set(item.id, fingerprint);

  try {
    await client.updateMeta(item.id, { urlId: item.urlId, description: item.description });
  } catch (err) {
    logger.debug('Could not update project metadata:', err);
  }
}

/**
 * Fetch a chat from the server.
 *
 * Returns null when unavailable or unknown so the caller falls back to the local
 * copy — a project opened on the device that created it should not depend on the
 * network.
 */
export async function pullChat(id: string): Promise<ChatHistoryItem | null> {
  if (!isAvailable()) {
    return null;
  }

  try {
    const result = await getProjectsClient().get(id);

    if (!result || result.messages.length === 0) {
      return null;
    }

    known.add(result.project.projectId);

    return {
      id: result.project.projectId,
      urlId: result.project.urlId,
      description: result.project.description,
      messages: result.messages,
      timestamp: new Date(result.project.updatedAt).toISOString(),
    };
  } catch (err) {
    logger.debug('Could not read chat from the server:', err);
    return null;
  }
}

/** Project summaries from the server, for the sidebar. Empty when unavailable. */
export async function pullChatList(): Promise<ChatHistoryItem[]> {
  if (!isAvailable()) {
    return [];
  }

  try {
    const projects = await getProjectsClient().list();

    return projects.map((project) => ({
      id: project.projectId,
      urlId: project.urlId,
      description: project.description,
      // Summaries carry no messages; the sidebar only needs id, description and
      // timestamp, and fetching every conversation to build a list would be
      // wasteful.
      messages: [],
      timestamp: new Date(project.updatedAt).toISOString(),
    }));
  } catch (err) {
    logger.debug('Could not list projects from the server:', err);
    return [];
  }
}

export async function deleteChat(id: string): Promise<void> {
  if (!isAvailable()) {
    return;
  }

  try {
    await getProjectsClient().remove(id);
    known.delete(id);
  } catch (err) {
    logger.debug('Could not delete the project on the server:', err);
  }
}

/**
 * Upload local chats the server does not have yet.
 *
 * Existing users have real history that predates server storage, and it would be
 * lost the moment they cleared their browser. Keyed by the id the browser already
 * assigned, so URLs keep working.
 *
 * Nothing local is ever deleted: if an upload fails the user still has their
 * history, and the next load tries again. Idempotent, so running it on every load
 * is safe.
 */
export async function migrateLocalChats(local: ChatHistoryItem[]): Promise<number> {
  if (!isAvailable() || local.length === 0) {
    return 0;
  }

  let migrated = 0;

  try {
    const remoteIds = new Set((await getProjectsClient().list()).map((project) => project.projectId));

    for (const item of local) {
      if (remoteIds.has(item.id) || !item.messages?.length) {
        continue;
      }

      await pushChat(item);
      migrated++;
    }

    if (migrated > 0) {
      logger.info(`Migrated ${migrated} local project(s) to the server`);
    }
  } catch (err) {
    logger.debug('Could not migrate local chats:', err);
  }

  return migrated;
}

/** Reset cached state. Test seam. */
export function resetSyncState(): void {
  known.clear();
  sentMeta.clear();

  for (const state of syncState.values()) {
    if (state.timer) {
      clearTimeout(state.timer);
    }
  }

  syncState.clear();
}

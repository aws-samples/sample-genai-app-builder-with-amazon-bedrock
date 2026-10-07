import type { Message } from 'ai';
import { createScopedLogger } from '~/utils/logger';
import type { ChatHistoryItem } from './useChatHistory';
import { pushChat, pullChat, pullChatList, deleteChat } from './sync';

const logger = createScopedLogger('ChatHistory');

// this is used at the top level and never rejects
export async function openDatabase(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    const request = indexedDB.open('boltHistory', 1);

    request.onupgradeneeded = (event: IDBVersionChangeEvent) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains('chats')) {
        const store = db.createObjectStore('chats', { keyPath: 'id' });
        store.createIndex('id', 'id', { unique: true });
        store.createIndex('urlId', 'urlId', { unique: true });
      }
    };

    request.onsuccess = (event: Event) => {
      resolve((event.target as IDBOpenDBRequest).result);
    };

    request.onerror = (event: Event) => {
      resolve(undefined);
      logger.error((event.target as IDBOpenDBRequest).error);
    };
  });
}

/**
 * Every chat this user can see, local and server-side merged.
 *
 * A device that has never opened a project still needs it in the sidebar, and a
 * project created before this became server-backed only exists locally — so
 * neither source alone is complete. Local wins on conflict because it is the more
 * recently written copy in the common case.
 */
export async function getAll(db: IDBDatabase): Promise<ChatHistoryItem[]> {
  const [local, remote] = await Promise.all([getAllLocal(db), pullChatList()]);
  const byId = new Map<string, ChatHistoryItem>();

  for (const item of remote) {
    byId.set(item.id, item);
  }

  for (const item of local) {
    byId.set(item.id, item);
  }

  return [...byId.values()];
}

function getAllLocal(db: IDBDatabase): Promise<ChatHistoryItem[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result as ChatHistoryItem[]);
    request.onerror = () => reject(request.error);
  });
}

export async function setMessages(
  db: IDBDatabase,
  id: string,
  messages: Message[],
  urlId?: string,
  description?: string,
): Promise<void> {
  // Mirror to the server so the chat is not confined to this browser. Not awaited:
  // the local write below is what the UI depends on, and making every keystroke's
  // save wait on a round trip would make the app feel worse for a guarantee the
  // user cannot see. A failure is retried by the next save.
  void pushChat({ id, messages, urlId, description });

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readwrite');
    const store = transaction.objectStore('chats');

    const request = store.put({
      id,
      messages,
      urlId,
      description,
      timestamp: new Date().toISOString(),
    });

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Load a chat by project id or url id.
 *
 * Local first, because the common case is reopening a project on the device that
 * created it and that should not need the network. Falls back to the server, which
 * is what lets a project appear on a second device, survive clearing browser data,
 * and be readable by someone invited into the session. Anything fetched is written
 * back locally so the next open is immediate.
 */
export async function getMessages(db: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  const local = (await getMessagesById(db, id)) || (await getMessagesByUrlId(db, id));

  if (local?.messages?.length) {
    return local;
  }

  const remote = await pullChat(id);

  if (!remote) {
    return local;
  }

  await cacheLocally(db, remote);

  return remote;
}

/**
 * Write a server-fetched chat into the local database.
 *
 * Uses a direct put rather than setMessages so it does not immediately push the
 * same data back to the server it just came from.
 */
async function cacheLocally(db: IDBDatabase, item: ChatHistoryItem): Promise<void> {
  return new Promise((resolve) => {
    try {
      const transaction = db.transaction('chats', 'readwrite');
      const request = transaction.objectStore('chats').put({
        id: item.id,
        messages: item.messages,
        urlId: item.urlId,
        description: item.description,
        timestamp: item.timestamp,
      });

      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    } catch {
      // A cache write failing is not worth propagating — the caller already has
      // the data it asked for.
      resolve();
    }
  });
}

export async function getMessagesByUrlId(db: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const index = store.index('urlId');
    const request = index.get(id);

    request.onsuccess = () => resolve(request.result as ChatHistoryItem);
    request.onerror = () => reject(request.error);
  });
}

export async function getMessagesById(db: IDBDatabase, id: string): Promise<ChatHistoryItem> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const request = store.get(id);

    request.onsuccess = () => resolve(request.result as ChatHistoryItem);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteById(db: IDBDatabase, id: string): Promise<void> {
  // Delete server-side too, or the chat would reappear in the sidebar on the next
  // load from the merged list.
  void deleteChat(id);

  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readwrite');
    const store = transaction.objectStore('chats');
    const request = store.delete(id);

    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
}

export async function getNextId(): Promise<string> {
  return newProjectId();
}

/**
 * A globally-unique id for a new project.
 *
 * This used to be a per-browser running counter — max existing key + 1 — so every
 * user's first project was "1", their second "2", and so on. That was fine while
 * chat lived only in this browser, but it collides the moment projects became
 * server-backed and shareable:
 *
 *  - the projects table is keyed on `projectId` alone, so two different users'
 *    "project 1" are the *same* DynamoDB partition;
 *  - an invite carries the project id, and a guest resolves it against their own
 *    local history first — so a numeric id resolves to the guest's *own* project
 *    of the same number, and the invited collaborator saw their own conversation
 *    beside the shared files instead of the owner's.
 *
 * A random id is unique across browsers and users, so a project is created,
 * shared and loaded under exactly one identity everywhere. Existing numeric ids
 * keep working — they are only ever read back, never regenerated.
 */
function newProjectId(): string {
  const c = (globalThis.crypto ?? (globalThis as any).window?.crypto) as Crypto | undefined;

  if (c?.randomUUID) {
    return c.randomUUID();
  }

  // Engines without randomUUID: a timestamp plus two random suffixes is unique
  // enough (ms epoch × 2^64 of randomness) and never collides across browsers.
  return `${Date.now().toString(36)}-${shortRandomSuffix()}-${shortRandomSuffix()}`;
}

export async function getUrlId(db: IDBDatabase, id: string): Promise<string> {
  // Slug-based URLs used to collide across chats: a second chat that
  // produced the same artifact id (e.g. "minimalistic-cinema") would fall
  // back to the existing first-chat record. Appending a short random
  // suffix guarantees uniqueness per chat while keeping the slug readable.
  const slug = slugify(id);
  const suffix = shortRandomSuffix();
  const candidate = `${slug}-${suffix}`;

  // Belt-and-braces: if the random suffix happens to collide, regenerate
  // until we find a free slot. Cardinality is 36^6 ≈ 2.2B so a second
  // call is essentially unreachable.
  const idList = await getUrlIds(db);
  if (!idList.includes(candidate)) return candidate;
  let retry = 0;
  while (retry < 5) {
    const next = `${slug}-${shortRandomSuffix()}`;
    if (!idList.includes(next)) return next;
    retry++;
  }
  // Truly pathological collision — fall back to a pure random id so we
  // never hand back a colliding slug.
  return `chat-${shortRandomSuffix()}-${shortRandomSuffix()}`;
}

// Lowercase, hyphen-separated, stripped of any character that is not
// URL-safe. Keeps the readable intent of the artifact id without letting
// weird characters leak into the route.
function slugify(raw: string): string {
  const trimmed = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return trimmed || 'chat';
}

// 6 chars of crypto-randomness in base36. Browsers all have crypto.
// Reads nicely: `minimalistic-cinema-f3a9b1`.
function shortRandomSuffix(): string {
  const bytes = new Uint8Array(4);
  (globalThis.crypto ?? window.crypto).getRandomValues(bytes);
  let n = 0;
  for (const b of bytes) n = (n << 8) | b;
  // Unsigned 32-bit → base36, pad to 6 chars.
  return (n >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

async function getUrlIds(db: IDBDatabase): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('chats', 'readonly');
    const store = transaction.objectStore('chats');
    const idList: string[] = [];

    const request = store.openCursor();

    request.onsuccess = (event: Event) => {
      const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;

      if (cursor) {
        idList.push(cursor.value.urlId);
        cursor.continue();
      } else {
        resolve(idList);
      }
    };

    request.onerror = () => {
      reject(request.error);
    };
  });
}

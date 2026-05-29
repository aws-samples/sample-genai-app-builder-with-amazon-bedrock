/**
 * Per-chat "attached brand template" persistence, backed by IndexedDB.
 *
 * One skill can be attached to a chat; attaching a second replaces the first.
 * The chip in the composer reads `getAttachedSkill(chatId)` on mount; the
 * picker writes via `setAttachedSkill(chatId, skillId)`; the chip's ✕ clears
 * via `clearAttachedSkill(chatId)`.
 *
 * We only store the skill id (+ timestamp). The full skill is fetched
 * server-side when the chat message is sent (so the system prompt always has
 * the latest record, including any PATCH the user made).
 */

const DB_NAME = 'bedrock-vibe-design-skills';
const STORE = 'chat-attachments';
// Version 2 introduces a sibling `pending-jobs` store (see pending-jobs.ts).
// Both modules MUST agree on the version; whichever opens the DB first
// runs the onupgradeneeded handler and creates any missing stores.
const PENDING_STORE = 'pending-jobs';
const DB_VERSION = 2;

export interface ChatAttachment {
  chatId: string;
  skillId: string;
  attachedAt: string;
}

function isBrowser(): boolean {
  return typeof window !== 'undefined' && typeof indexedDB !== 'undefined';
}

async function openDb(): Promise<IDBDatabase> {
  if (!isBrowser()) {
    throw new Error('IndexedDB is only available in the browser.');
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'chatId' });
      }
      // Create the pending-jobs store too if this open() handles the v1→v2
      // upgrade, so pending-jobs.ts doesn't have to race.
      if (!db.objectStoreNames.contains(PENDING_STORE)) {
        db.createObjectStore(PENDING_STORE, { keyPath: 'jobId' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTx<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      Promise.resolve(fn(store))
        .then((value) => {
          tx.oncomplete = () => resolve(value);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
        .catch(reject);
    });
  } finally {
    db.close();
  }
}

export async function setAttachedSkill(chatId: string, skillId: string): Promise<void> {
  if (!isBrowser()) return;
  const record: ChatAttachment = {
    chatId,
    skillId,
    attachedAt: new Date().toISOString(),
  };
  await runTx('readwrite', (store) => {
    return new Promise<void>((resolve, reject) => {
      const request = store.put(record);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

export async function getAttachedSkill(chatId: string): Promise<ChatAttachment | null> {
  if (!isBrowser()) return null;
  return runTx('readonly', (store) => {
    return new Promise<ChatAttachment | null>((resolve, reject) => {
      const request = store.get(chatId);
      request.onsuccess = () => resolve((request.result as ChatAttachment | undefined) ?? null);
      request.onerror = () => reject(request.error);
    });
  });
}

export async function clearAttachedSkill(chatId: string): Promise<void> {
  if (!isBrowser()) return;
  await runTx('readwrite', (store) => {
    return new Promise<void>((resolve, reject) => {
      const request = store.delete(chatId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

/**
 * Persistent record of brand-template extractions still in flight.
 *
 * Why this exists: extractions can take 5-10 minutes (multimodal Bedrock
 * + URL/CSS fetches), and users naturally navigate away. Without this
 * store, leaving the extraction page = losing visibility entirely. With
 * it, a top-level watcher resumes polling on app load and toasts the
 * user when their skill becomes ready (or fails).
 *
 * Schema: {jobId, skillId, name, startedAt}. We track only what's
 * needed to drive a status query and a "click here to view" toast —
 * the actual skill is fetched on the detail page like any other.
 *
 * IMPORTANT: shares the `bedrock-vibe-design-skills` IndexedDB with
 * chat-attachment.ts. The version bump (1 → 2) creates the new store
 * without touching the existing `chat-attachments` data.
 */

const DB_NAME = 'bedrock-vibe-design-skills';
const ATTACHMENT_STORE = 'chat-attachments';
const PENDING_STORE = 'pending-jobs';
const DB_VERSION = 2;

export interface PendingJob {
  jobId: string;
  skillId: string;
  name: string;
  startedAt: string;
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
      // chat-attachments is owned by chat-attachment.ts; we just ensure
      // it exists during this upgrade so a fresh client picks up both
      // stores in one open() call.
      if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) {
        db.createObjectStore(ATTACHMENT_STORE, { keyPath: 'chatId' });
      }
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
      const tx = db.transaction(PENDING_STORE, mode);
      const store = tx.objectStore(PENDING_STORE);
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

export async function recordPendingJob(job: PendingJob): Promise<void> {
  if (!isBrowser()) return;
  await runTx('readwrite', (store) => {
    return new Promise<void>((resolve, reject) => {
      const request = store.put(job);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

export async function listPendingJobs(): Promise<PendingJob[]> {
  if (!isBrowser()) return [];
  return runTx('readonly', (store) => {
    return new Promise<PendingJob[]>((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve((request.result as PendingJob[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  });
}

export async function removePendingJob(jobId: string): Promise<void> {
  if (!isBrowser()) return;
  await runTx('readwrite', (store) => {
    return new Promise<void>((resolve, reject) => {
      const request = store.delete(jobId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  });
}

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Minimal in-memory IndexedDB stand-in covering only what chat-attachment
 * needs. Avoids pulling in fake-indexeddb as a dev dependency.
 */

type Record = { chatId: string; skillId: string; attachedAt: string };

class MiniObjectStore {
  data = new Map<string, Record>();

  put(record: Record): MiniRequest {
    this.data.set(record.chatId, record);
    return new MiniRequest(undefined);
  }

  get(key: string): MiniRequest {
    return new MiniRequest(this.data.get(key));
  }

  delete(key: string): MiniRequest {
    this.data.delete(key);
    return new MiniRequest(undefined);
  }
}

class MiniRequest {
  result: any;
  private _onsuccess: (() => void) | null = null;
  private _onerror: (() => void) | null = null;

  constructor(result: any) {
    this.result = result;
  }

  set onsuccess(fn: (() => void) | null) {
    this._onsuccess = fn;
    if (fn) {
      queueMicrotask(() => fn());
    }
  }

  get onsuccess(): (() => void) | null {
    return this._onsuccess;
  }

  set onerror(fn: (() => void) | null) {
    this._onerror = fn;
  }

  get onerror(): (() => void) | null {
    return this._onerror;
  }
}

class MiniTransaction {
  private _oncomplete: (() => void) | null = null;
  private _onerror: (() => void) | null = null;
  private _onabort: (() => void) | null = null;
  error: any = null;

  constructor(private store: MiniObjectStore) {}

  objectStore() {
    return this.store;
  }

  set oncomplete(fn: (() => void) | null) {
    this._oncomplete = fn;
    if (fn) {
      queueMicrotask(() => fn());
    }
  }

  get oncomplete(): (() => void) | null {
    return this._oncomplete;
  }

  set onerror(fn: (() => void) | null) {
    this._onerror = fn;
  }

  get onerror(): (() => void) | null {
    return this._onerror;
  }

  set onabort(fn: (() => void) | null) {
    this._onabort = fn;
  }

  get onabort(): (() => void) | null {
    return this._onabort;
  }
}

class MiniDatabase {
  objectStoreNames = { contains: () => true };
  private store = new MiniObjectStore();

  transaction(_storeName: string, _mode: string): MiniTransaction {
    return new MiniTransaction(this.store);
  }

  close() {
    // no-op
  }

  createObjectStore() {
    return this.store;
  }
}

class MiniOpenRequest {
  result = new MiniDatabase();
  private _onupgradeneeded: (() => void) | null = null;
  private _onsuccess: (() => void) | null = null;
  private _onerror: (() => void) | null = null;

  set onupgradeneeded(fn: (() => void) | null) {
    this._onupgradeneeded = fn;
  }

  get onupgradeneeded(): (() => void) | null {
    return this._onupgradeneeded;
  }

  set onsuccess(fn: (() => void) | null) {
    this._onsuccess = fn;
    if (fn) {
      queueMicrotask(() => {
        this._onupgradeneeded?.();
        fn();
      });
    }
  }

  get onsuccess(): (() => void) | null {
    return this._onsuccess;
  }

  set onerror(fn: (() => void) | null) {
    this._onerror = fn;
  }

  get onerror(): (() => void) | null {
    return this._onerror;
  }
}

// One shared database per describe block to simulate persistence across calls.
let db: MiniDatabase;

beforeEach(() => {
  db = new MiniDatabase();
  vi.resetModules();
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).indexedDB = {
    open: () => {
      const request = new MiniOpenRequest();
      request.result = db;
      return request;
    },
  };
});

describe('chat-attachment', () => {
  it('round-trips skill attachment for a chat', async () => {
    const { setAttachedSkill, getAttachedSkill } = await import('../chat-attachment');
    await setAttachedSkill('chat-1', 'skill-1');
    const record = await getAttachedSkill('chat-1');
    expect(record?.chatId).toBe('chat-1');
    expect(record?.skillId).toBe('skill-1');
    expect(record?.attachedAt).toMatch(/^2\d{3}-/);
  });

  it('replaces the attachment when set twice', async () => {
    const { setAttachedSkill, getAttachedSkill } = await import('../chat-attachment');
    await setAttachedSkill('chat-1', 'skill-a');
    await setAttachedSkill('chat-1', 'skill-b');
    const record = await getAttachedSkill('chat-1');
    expect(record?.skillId).toBe('skill-b');
  });

  it('isolates attachments across chats', async () => {
    const { setAttachedSkill, getAttachedSkill } = await import('../chat-attachment');
    await setAttachedSkill('chat-1', 'skill-1');
    await setAttachedSkill('chat-2', 'skill-2');
    expect((await getAttachedSkill('chat-1'))?.skillId).toBe('skill-1');
    expect((await getAttachedSkill('chat-2'))?.skillId).toBe('skill-2');
  });

  it('clear removes the attachment', async () => {
    const { setAttachedSkill, getAttachedSkill, clearAttachedSkill } = await import(
      '../chat-attachment'
    );
    await setAttachedSkill('chat-1', 'skill-1');
    await clearAttachedSkill('chat-1');
    expect(await getAttachedSkill('chat-1')).toBeNull();
  });

  it('returns null when no attachment exists', async () => {
    const { getAttachedSkill } = await import('../chat-attachment');
    expect(await getAttachedSkill('unknown')).toBeNull();
  });
});

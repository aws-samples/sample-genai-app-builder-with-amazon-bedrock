import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Message } from 'ai';

/**
 * Chat used to live only in this browser, so losing it lost every project and an
 * invited collaborator saw an empty conversation. These tests pin the two
 * properties that make moving it server-side safe:
 *
 *  - it is additive: a server that is unreachable, or auth that has not hydrated,
 *    must never stop someone editing, because the local write already succeeded;
 *  - it is idempotent: the existing save path re-sends the whole message array on
 *    every turn, so pushing must converge rather than duplicate.
 */
const list = vi.fn();
const create = vi.fn();
const appendMessages = vi.fn();
const get = vi.fn();
const remove = vi.fn();
const updateMeta = vi.fn();

vi.mock('~/lib/api/projects-client', () => ({
  getProjectsClient: () => ({ list, create, appendMessages, get, remove, updateMeta }),
  ProjectsApiError: class ProjectsApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message);
      this.name = 'ProjectsApiError';
    }
  },
}));

/** The 409 an invited collaborator gets: the project exists and the owner owns it. */
async function conflict() {
  const { ProjectsApiError } = await import('~/lib/api/projects-client');
  return new ProjectsApiError('POST /projects failed: 409', 409);
}

/** The 429 the server sends when a project's DynamoDB write capacity is spent. */
async function tooManyRequests() {
  const { ProjectsApiError } = await import('~/lib/api/projects-client');
  return new ProjectsApiError('POST /projects/p1/messages failed: 429', 429);
}

const message = (id: string): Message => ({ id, role: 'user', content: 'hi' }) as Message;

async function loadSync() {
  const mod = await import('./sync');
  mod.resetSyncState();
  return mod;
}

describe('chat sync', () => {
  beforeEach(() => {
    vi.resetModules();
    list.mockReset().mockResolvedValue([]);
    create.mockReset().mockResolvedValue({ projectId: 'p1' });
    appendMessages.mockReset().mockResolvedValue(undefined);
    get.mockReset().mockResolvedValue(null);
    remove.mockReset().mockResolvedValue(undefined);
    updateMeta.mockReset().mockResolvedValue(undefined);
    (globalThis as any).window = { ENV: { API_GATEWAY_REST_URL: 'https://api.test/' } };
  });

  describe('pushChat', () => {
    it('creates the project once, then only appends', async () => {
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });
      await pushChat({ id: 'p1', messages: [message('m1'), message('m2')] });

      expect(create).toHaveBeenCalledTimes(1);
      expect(appendMessages).toHaveBeenCalledTimes(2);
    });

    it('reuses the id the browser already assigned, so URLs keep working', async () => {
      const { pushChat } = await loadSync();

      await pushChat({ id: 'existing-local-id', urlId: 'my-app-a1b2', messages: [message('m1')] });

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'existing-local-id', urlId: 'my-app-a1b2' }));
    });

    it('never throws when the server is unreachable', async () => {
      create.mockRejectedValue(new Error('network down'));
      const { pushChat } = await loadSync();

      await expect(pushChat({ id: 'p1', messages: [message('m1')] })).resolves.toBeUndefined();
    });

    it('does nothing when there is no API configured (local dev)', async () => {
      (globalThis as any).window = { ENV: {} };
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });

      expect(create).not.toHaveBeenCalled();
    });

    it('skips an empty conversation', async () => {
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [] });

      expect(create).not.toHaveBeenCalled();
    });

    /**
     * An invited collaborator is a member, not the owner, so `create` answers 409
     * for the shared project. That is expected — and it must not cost them their
     * message. Membership is what authorises the append, and appending is the
     * whole reason the project is shared.
     */
    it('still appends when the project already exists and someone else owns it', async () => {
      create.mockRejectedValue(await conflict());
      const { pushChat } = await loadSync();

      await pushChat({ id: 'owners-project', messages: [message('guest-msg')] });

      expect(appendMessages).toHaveBeenCalledWith('owners-project', [message('guest-msg')]);
    });

    it("does not re-attempt create on a guest's later turns", async () => {
      create.mockRejectedValue(await conflict());
      const { pushChat } = await loadSync();

      await pushChat({ id: 'owners-project', messages: [message('m1')] });
      await pushChat({ id: 'owners-project', messages: [message('m1'), message('m2')] });

      expect(create).toHaveBeenCalledTimes(1);
      expect(appendMessages).toHaveBeenCalledTimes(2);
    });

    it('retries create after a transient failure rather than giving up on it', async () => {
      create.mockRejectedValueOnce(new Error('network down')).mockResolvedValue({ projectId: 'p1' });
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });
      await pushChat({ id: 'p1', messages: [message('m1'), message('m2')] });

      expect(create).toHaveBeenCalledTimes(2);
      expect(appendMessages).toHaveBeenCalledTimes(2);
    });

    /**
     * The first save happens before the AI has produced an artifact, so there is
     * no slug or title to send yet — they arrive on a later turn. Without this the
     * server never learns the urlId, and a guest resolving the shared project gets
     * `urlId: undefined`, mints its own slug and ends up on a different URL from
     * the owner for the same conversation.
     */
    it('sends the urlId and description once they exist, not only at create', async () => {
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ urlId: undefined }));

      await pushChat({ id: 'p1', urlId: 'my-app-a1b2', description: 'My App', messages: [message('m1')] });

      expect(updateMeta).toHaveBeenCalledWith('p1', { urlId: 'my-app-a1b2', description: 'My App' });
    });

    it('does not re-send metadata the server already has', async () => {
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', urlId: 'my-app-a1b2', description: 'My App', messages: [message('m1')] });
      await pushChat({ id: 'p1', urlId: 'my-app-a1b2', description: 'My App', messages: [message('m1')] });

      expect(updateMeta).not.toHaveBeenCalled();
    });

    it('never throws when the metadata update fails', async () => {
      updateMeta.mockRejectedValue(new Error('forbidden'));
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });

      // A changed array, because an unchanged one is deliberately not re-sent now.
      await expect(
        pushChat({ id: 'p1', urlId: 'u', description: 'd', messages: [message('m1'), message('m2')] }),
      ).resolves.toBeUndefined();
      expect(appendMessages).toHaveBeenCalledTimes(2);
    });
  });

  /**
   * The other half of the production 500s. `storeMessageHistory` runs on every
   * message change, so a single session sent dozens of full-conversation writes at
   * one DynamoDB partition key — and on failure re-sent the same thing on the very
   * next change, deepening the throttle it had just caused.
   */
  describe('pushChat — write pressure', () => {
    it('does not re-send a message array the server already has', async () => {
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });
      await pushChat({ id: 'p1', messages: [message('m1')] });

      expect(appendMessages).toHaveBeenCalledTimes(1);
    });

    it('coalesces saves that arrive while one is still in flight', async () => {
      appendMessages.mockImplementation(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
      const { pushChat } = await loadSync();

      const settled = pushChat({ id: 'p1', messages: [message('m1')] });

      // Streaming: two more snapshots land before the first request answers.
      void pushChat({ id: 'p1', messages: [message('m1'), message('m2')] });
      void pushChat({ id: 'p1', messages: [message('m1'), message('m2'), message('m3')] });

      await settled;

      // One request for the first snapshot and one for the newest, not three.
      expect(appendMessages).toHaveBeenCalledTimes(2);
      expect(appendMessages).toHaveBeenLastCalledWith('p1', [message('m1'), message('m2'), message('m3')]);
    });

    it('backs off after a rejected save instead of retrying on the next change', async () => {
      appendMessages.mockRejectedValue(await tooManyRequests());
      const { pushChat } = await loadSync();

      await pushChat({ id: 'p1', messages: [message('m1')] });
      expect(appendMessages).toHaveBeenCalledTimes(1);

      // The next message change arrives immediately, as it does mid-conversation.
      await pushChat({ id: 'p1', messages: [message('m1'), message('m2')] });

      expect(appendMessages).toHaveBeenCalledTimes(1);
    });

    it('retries the newest snapshot once the backoff has elapsed', async () => {
      vi.useFakeTimers();

      try {
        appendMessages.mockRejectedValueOnce(await tooManyRequests()).mockResolvedValue(undefined);
        const { pushChat } = await loadSync();

        await pushChat({ id: 'p1', messages: [message('m1')] });
        await pushChat({ id: 'p1', messages: [message('m1'), message('m2')] });
        expect(appendMessages).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60_000);

        // The failed write is not forgotten, and what lands is the latest state.
        expect(appendMessages).toHaveBeenCalledTimes(2);
        expect(appendMessages).toHaveBeenLastCalledWith('p1', [message('m1'), message('m2')]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('pullChat', () => {
    it('returns the server copy in the shape the local store uses', async () => {
      get.mockResolvedValue({
        project: { projectId: 'p1', urlId: 'u1', description: 'My app', updatedAt: 1700000000000 },
        messages: [message('m1')],
      });

      const { pullChat } = await loadSync();
      const result = await pullChat('p1');

      expect(result).toMatchObject({ id: 'p1', urlId: 'u1', description: 'My app' });
      expect(result?.messages).toHaveLength(1);
      expect(typeof result?.timestamp).toBe('string');
    });

    it('returns null for an unknown project so the caller keeps its local copy', async () => {
      const { pullChat } = await loadSync();
      await expect(pullChat('nope')).resolves.toBeNull();
    });

    it('returns null rather than throwing when the server errors', async () => {
      get.mockRejectedValue(new Error('boom'));
      const { pullChat } = await loadSync();

      await expect(pullChat('p1')).resolves.toBeNull();
    });
  });

  describe('migrateLocalChats', () => {
    it('uploads only the projects the server does not already have', async () => {
      list.mockResolvedValue([{ projectId: 'already-there' }]);
      const { migrateLocalChats } = await loadSync();

      const count = await migrateLocalChats([
        { id: 'already-there', messages: [message('m1')], timestamp: 't' },
        { id: 'new-one', messages: [message('m2')], timestamp: 't' },
      ] as any);

      expect(count).toBe(1);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-one' }));
    });

    it('ignores empty local chats', async () => {
      const { migrateLocalChats } = await loadSync();

      const count = await migrateLocalChats([{ id: 'empty', messages: [], timestamp: 't' }] as any);

      expect(count).toBe(0);
    });

    it('reports zero and does not throw when the server is unavailable', async () => {
      list.mockRejectedValue(new Error('offline'));
      const { migrateLocalChats } = await loadSync();

      await expect(migrateLocalChats([{ id: 'a', messages: [message('m')], timestamp: 't' }] as any)).resolves.toBe(0);
    });
  });
});

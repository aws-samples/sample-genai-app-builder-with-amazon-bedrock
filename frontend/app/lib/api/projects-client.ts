import type { Message } from 'ai';
import { ApiClientBase } from './api-client-base';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('ProjectsClient');

/**
 * A non-2xx response, carrying the status so callers can act on it.
 *
 * The status is the difference between "this will never work" and "try again":
 * a 409 from `create` means the project exists and someone else owns it, which
 * is the normal answer for an invited collaborator and must not be treated like
 * a network failure.
 */
export class ProjectsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /**
     * How long the server asked the caller to wait, in ms, from `Retry-After`.
     * A 429 from a message write carries one, and it is a better number than any
     * backoff the client could guess.
     */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProjectsApiError';
  }
}

/**
 * `Retry-After` in ms, when the server sent a usable one.
 *
 * Only the delta-seconds form is read: it is what this API sends, and guessing at
 * a malformed value would be worse than falling back to the caller's own backoff.
 */
function retryAfterMsOf(response: Response): number | undefined {
  const header = response.headers?.get?.('Retry-After');
  const seconds = header === null || header === undefined ? NaN : Number(header);

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
}

/** Project metadata as returned by the API, without its messages. */
export interface ProjectSummary {
  projectId: string;
  urlId?: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectWithMessages {
  project: ProjectSummary;
  messages: Message[];
}

/**
 * Server-side project and chat history.
 *
 * Chat used to live only in browser IndexedDB, so losing a browser lost every
 * project, a project could not be opened on another device, and an invited
 * collaborator saw an empty conversation. This client is the durable side of
 * that; the local database stays in place as a cache and offline fallback.
 */
export class ProjectsClient extends ApiClientBase {
  private getBaseUrl(): string {
    if (typeof window !== 'undefined' && window.location.origin) {
      return window.location.origin;
    }

    const url = window.ENV?.API_GATEWAY_REST_URL;

    if (!url) {
      throw new Error('API_GATEWAY_REST_URL not configured. Check /api/config endpoint.');
    }

    return url.endsWith('/') ? url.slice(0, -1) : url;
  }

  private async send<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = await this.getHeaders();

    const response = await fetch(`${this.getBaseUrl()}${path}`, {
      ...init,
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });

    if (!response.ok) {
      throw new ProjectsApiError(
        `${init.method ?? 'GET'} ${path} failed: ${response.status}`,
        response.status,
        retryAfterMsOf(response),
      );
    }

    return (await response.json()) as T;
  }

  async list(): Promise<ProjectSummary[]> {
    const { projects } = await this.send<{ projects: ProjectSummary[] }>('/projects');
    return projects ?? [];
  }

  /**
   * Create a project, optionally with an id chosen by the caller.
   *
   * The id is supplied when adopting a project that already exists locally, so
   * its URLs keep working after it moves server-side.
   */
  async create(input: { id?: string; urlId?: string; description?: string }): Promise<ProjectSummary> {
    const { project } = await this.send<{ project: ProjectSummary }>('/projects', {
      method: 'POST',
      body: JSON.stringify(input),
    });

    return project;
  }

  /** Fetch a project and its messages. Resolves by project id or urlId. */
  async get(id: string): Promise<ProjectWithMessages | null> {
    try {
      return await this.send<ProjectWithMessages>(`/projects/${encodeURIComponent(id)}`);
    } catch (err) {
      logger.debug('Project not available from the server:', err);
      return null;
    }
  }

  async appendMessages(id: string, messages: Message[]): Promise<void> {
    await this.send(`/projects/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ messages }),
    });
  }

  /**
   * Grant another user access to this project's conversation.
   *
   * Used when inviting someone into a live session: sharing the sandbox gives them
   * the files, and this gives them the history behind those files. Owner-only
   * server-side, and idempotent, so a repeated invite is harmless.
   */
  async addMember(id: string, userId: string): Promise<void> {
    await this.send(`/projects/${encodeURIComponent(id)}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });
  }

  async updateDescription(id: string, description: string): Promise<void> {
    await this.updateMeta(id, { description });
  }

  /**
   * Fill in metadata that did not exist when the project was created.
   *
   * A project is created server-side on its first save, which happens before the
   * AI has produced an artifact — so there is no slug or title to send yet. Both
   * arrive a turn later, and without this the server would never learn them:
   * a collaborator resolving the shared project would get no `urlId` and mint
   * their own, landing on a different URL from the owner for one conversation.
   */
  async updateMeta(id: string, patch: { urlId?: string; description?: string }): Promise<void> {
    await this.send(`/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async remove(id: string): Promise<void> {
    await this.send(`/projects/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }
}

let client: ProjectsClient | null = null;

export function getProjectsClient(): ProjectsClient {
  if (!client) {
    client = new ProjectsClient();
  }

  return client;
}

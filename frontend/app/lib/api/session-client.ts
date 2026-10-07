import { ApiClientBase } from './api-client-base';
import { getCurrentUserId } from './user-id';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('SessionClient');

interface CreateSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
  /** Live preview URL on the untrusted-content origin (never the app's). */
  previewUrl?: string;
  /**
   * Project the invite also granted, when joining a shared session. Lets the
   * joiner load the conversation behind the files rather than an empty chat.
   */
  projectId?: string;
}

/**
 * `GET /session/{id}`.
 *
 * The status lives inside `session` because the endpoint answers with the stored
 * record alongside a URL signed for this caller. It was previously declared
 * flat, which type-checked but read `undefined` at runtime — so a caller could not
 * tell a live session from one the backend had already stopped.
 */
interface SessionStatusResponse {
  session?: {
    sessionId: string;
    status: 'PENDING' | 'ACTIVE' | 'STOPPING' | 'STOPPED';
    [key: string]: unknown;
  };
  wsUrl?: string;
  previewDomain?: string;
  previewUrl?: string;
}

interface CreateInviteResponse {
  token: string;
  /** When the link stops being redeemable (epoch seconds). */
  expiresAt?: number;
}

export class SessionClient extends ApiClientBase {
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private async getUserId(): Promise<string> {
    const userId = await getCurrentUserId();

    if (!userId) {
      throw new Error('Unable to determine user identity. Please sign in again.');
    }

    return userId;
  }

  private getRestApiUrl(): string {
    if (typeof window !== 'undefined' && window.location.origin) {
      return window.location.origin;
    }

    const url = window.ENV?.API_GATEWAY_REST_URL;
    if (!url) {
      throw new Error('API_GATEWAY_REST_URL not configured. Check /api/config endpoint.');
    }
    return url.endsWith('/') ? url.slice(0, -1) : url;
  }

  /**
   * Issue an authenticated request, retrying once with a force-refreshed token
   * when the authorizer rejects the first attempt (401/403).
   *
   * A Cognito id-token is short-lived, so a session left open for a while can
   * present an expired token and get rejected on the first try. Re-minting the
   * token and replaying the request recovers transparently rather than
   * surfacing a spurious error. Mirrors the retry logic in chat-api-client.
   */
  private async authedFetch(url: string, init: { method: string; body?: string }): Promise<Response> {
    const send = async (forceRefresh: boolean): Promise<Response> => {
      const headers = await this.getHeaders({ forceRefresh });

      return fetch(url, {
        method: init.method,
        headers: init.body === undefined ? headers : { ...headers, 'Content-Type': 'application/json' },
        ...(init.body === undefined ? {} : { body: init.body }),
      });
    };

    const response = await send(false);

    if (response.status === 401 || response.status === 403) {
      logger.warn('auth rejected request, retrying with a refreshed token:', response.status);

      return send(true);
    }

    return response;
  }

  async createSession(): Promise<CreateSessionResponse> {
    const baseUrl = this.getRestApiUrl();

    const userId = await this.getUserId();
    logger.info('Creating sandbox session for user:', userId);

    const response = await this.authedFetch(`${baseUrl}/session`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to create session: ${response.status} ${body}`);
    }

    const data = (await response.json()) as CreateSessionResponse;
    this.sessionId = data.sessionId;

    // Never log `data.wsUrl`: it is CloudFront-signed and is the credential for
    // the sandbox socket until it expires.
    logger.info('Session created:', data.sessionId);

    this.startHeartbeat();

    return data;
  }

  /**
   * Mint an invite token for a session so a teammate can join it live.
   *
   * Only the owner may invite, and the project is only carried if the caller
   * owns it (the server refuses otherwise). The link is single-use, expires
   * after `expiresAt` if nobody redeems it, and revoking it also removes the
   * person who redeemed it. Once in, a collaborator stays a member until then.
   */
  async createInvite(sessionId?: string, projectId?: string): Promise<CreateInviteResponse> {
    const id = sessionId || this.sessionId;

    if (!id) {
      throw new Error('No active session');
    }

    const baseUrl = this.getRestApiUrl();

    const response = await this.authedFetch(`${baseUrl}/session/${id}/invite`, {
      method: 'POST',

      /**
       * Carrying the project means redeeming the invite grants its
       * conversation too, not just the sandbox.
       */
      body: JSON.stringify({ projectId }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to create invite: ${response.status} ${body}`);
    }

    return (await response.json()) as CreateInviteResponse;
  }

  /**
   * Redeem an invite token and adopt the inviter's session.
   *
   * Returns the OWNER's connection details, so the joiner's runtime connects to
   * the same container and sees the same files. Also starts the heartbeat: a
   * collaborator keeps the session alive while they are working in it.
   */
  async joinSession(token: string): Promise<CreateSessionResponse> {
    const baseUrl = this.getRestApiUrl();

    const response = await this.authedFetch(`${baseUrl}/session/join`, {
      method: 'POST',
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to join session: ${response.status} ${body}`);
    }

    const data = (await response.json()) as CreateSessionResponse;
    this.sessionId = data.sessionId;

    logger.info('Joined session:', data.sessionId);

    this.startHeartbeat();

    return data;
  }

  async getStatus(sessionId?: string): Promise<SessionStatusResponse> {
    const id = sessionId || this.sessionId;

    if (!id) {
      throw new Error('No active session');
    }

    const baseUrl = this.getRestApiUrl();

    const response = await this.authedFetch(`${baseUrl}/session/${id}`, {
      method: 'GET',
    });

    if (!response.ok) {
      throw new Error(`Failed to get session status: ${response.status}`);
    }

    return (await response.json()) as SessionStatusResponse;
  }

  /**
   * Adopt a session this browser already belongs to, without creating one.
   *
   * For a guest whose tab reloaded: the invite has been redeemed and forgotten, so
   * there is nothing to re-redeem, but membership is still recorded server-side and
   * `GET /session/{id}` answers a member with a URL freshly signed for them.
   * Creating a session instead would drop them out of the shared sandbox and into
   * an empty one of their own.
   *
   * Starts the heartbeat, which `getStatus` alone does not: a rejoined
   * collaborator has to keep counting as activity, or the session can be reaped
   * as idle while they are working in it.
   */
  async resumeSession(sessionId: string): Promise<SessionStatusResponse> {
    const status = await this.getStatus(sessionId);

    this.sessionId = sessionId;
    this.startHeartbeat();

    logger.info('Resumed session:', sessionId);

    return status;
  }

  async deleteSession(sessionId?: string): Promise<void> {
    const id = sessionId || this.sessionId;

    if (!id) {
      return;
    }

    this.stopHeartbeat();

    const baseUrl = this.getRestApiUrl();

    await this.authedFetch(`${baseUrl}/session/${id}`, {
      method: 'DELETE',
    });

    this.sessionId = null;
    logger.info('Session deleted:', id);
  }

  private startHeartbeat() {
    this.stopHeartbeat();

    const sendHeartbeat = async () => {
      if (!this.sessionId) return;
      try {
        const baseUrl = this.getRestApiUrl();
        await this.authedFetch(`${baseUrl}/session/${this.sessionId}/heartbeat`, {
          method: 'POST',
        });
        logger.debug('Heartbeat sent for session:', this.sessionId);
      } catch (e) {
        logger.warn('Heartbeat failed:', e);
      }
    };

    // Send heartbeat every 5 minutes to keep the session alive (30min timeout)
    this.heartbeatTimer = setInterval(sendHeartbeat, 5 * 60 * 1000);

    // Also send heartbeat when tab becomes visible again (recovers from sleep/background)
    if (typeof document !== 'undefined') {
      const onVisibilityChange = () => {
        if (document.visibilityState === 'visible' && this.sessionId) {
          sendHeartbeat();
        }
      };
      document.addEventListener('visibilitychange', onVisibilityChange);
      (this as any)._visibilityHandler = onVisibilityChange;
    }
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (typeof document !== 'undefined' && (this as any)._visibilityHandler) {
      document.removeEventListener('visibilitychange', (this as any)._visibilityHandler);
      (this as any)._visibilityHandler = null;
    }
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

let sessionClient: SessionClient | null = null;

export function getSessionClient(): SessionClient {
  if (!sessionClient) {
    sessionClient = new SessionClient();
  }

  return sessionClient;
}

import { fetchAuthSession } from 'aws-amplify/auth';
import { ApiClientBase } from './api-client-base';
import { createScopedLogger } from '~/utils/logger';

const logger = createScopedLogger('SessionClient');

interface CreateSessionResponse {
  sessionId: string;
  wsUrl: string;
  previewDomain: string;
}

interface SessionStatusResponse {
  sessionId: string;
  status: 'PENDING' | 'ACTIVE' | 'STOPPING' | 'STOPPED';
  wsUrl?: string;
  previewDomain?: string;
}

export class SessionClient extends ApiClientBase {
  private sessionId: string | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  private async getUserId(): Promise<string> {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload;
    const userId = (payload?.sub as string) || (payload?.email as string);

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

  async createSession(): Promise<CreateSessionResponse> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();

    const userId = await this.getUserId();
    logger.info('Creating sandbox session for user:', userId);

    const response = await fetch(`${baseUrl}/session`, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to create session: ${response.status} ${body}`);
    }

    const data = (await response.json()) as CreateSessionResponse;
    this.sessionId = data.sessionId;

    logger.info('Session created:', data.sessionId);
    logger.info('WebSocket URL:', data.wsUrl);

    this.startHeartbeat();

    return data;
  }

  async getStatus(sessionId?: string): Promise<SessionStatusResponse> {
    const id = sessionId || this.sessionId;

    if (!id) {
      throw new Error('No active session');
    }

    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();

    const response = await fetch(`${baseUrl}/session/${id}`, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Failed to get session status: ${response.status}`);
    }

    return (await response.json()) as SessionStatusResponse;
  }

  async deleteSession(sessionId?: string): Promise<void> {
    const id = sessionId || this.sessionId;

    if (!id) {
      return;
    }

    this.stopHeartbeat();

    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();

    await fetch(`${baseUrl}/session/${id}`, {
      method: 'DELETE',
      headers,
    });

    this.sessionId = null;
    logger.info('Session deleted:', id);
  }

  private startHeartbeat() {
    this.stopHeartbeat();

    // Send heartbeat every 5 minutes to keep the session alive (30min timeout)
    this.heartbeatTimer = setInterval(async () => {
      if (!this.sessionId) {
        return;
      }

      try {
        const baseUrl = this.getRestApiUrl();
        const headers = await this.getHeaders();

        await fetch(`${baseUrl}/session/${this.sessionId}/heartbeat`, {
          method: 'POST',
          headers,
        });

        logger.debug('Heartbeat sent for session:', this.sessionId);
      } catch (e) {
        logger.warn('Heartbeat failed:', e);
      }
    }, 5 * 60 * 1000);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
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

import { WORK_DIR_NAME } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';
import { RuntimeConnectionImpl } from './connection';
import type { RuntimeConfig, RuntimeConnection } from './types';

const logger = createScopedLogger('ContainerRuntime');

interface ContainerRuntimeContext {
  loaded: boolean;
  templateApplied: boolean;
}

export const containerRuntimeContext: ContainerRuntimeContext = import.meta.hot?.data.containerRuntimeContext ?? {
  loaded: false,
  templateApplied: false,
};

if (import.meta.hot) {
  import.meta.hot.data.containerRuntimeContext = containerRuntimeContext;
}

/**
 * Boot the container runtime by:
 * 1. Creating a sandbox session via API Gateway
 * 2. Connecting to the sidecar WebSocket agent at the returned URL
 */
export async function bootContainerRuntime(): Promise<RuntimeConnection> {
  // In production, create a session first to get the WebSocket URL
  const wsEndpoint = await resolveWsEndpoint();
  const authToken = await resolveAuthToken();

  const config: RuntimeConfig = {
    wsEndpoint,
    authToken,
    reconnect: true,
    reconnectInterval: 1000,
    maxReconnectAttempts: 10,
    requestTimeout: 120000,
    pingInterval: 30000,
  };

  logger.debug('Booting container runtime...', { wsEndpoint });
  const connection = new RuntimeConnectionImpl(config);
  await connection.connect();

  containerRuntimeContext.loaded = true;
  logger.debug('Container runtime connected');

  return connection;
}

/**
 * Wait for window.ENV to be populated by /api/config (loaded in AppConfigured).
 * Returns true if config loaded, false on timeout.
 */
async function waitForConfig(timeoutMs = 15000): Promise<boolean> {
  if (typeof window === 'undefined') {
    return false;
  }

  if (window.ENV?.API_GATEWAY_REST_URL) {
    return true;
  }

  const start = Date.now();

  return new Promise((resolve) => {
    const check = () => {
      if (window.ENV?.API_GATEWAY_REST_URL) {
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        logger.warn('Timed out waiting for API config');
        resolve(false);
      } else {
        setTimeout(check, 200);
      }
    };

    check();
  });
}

/**
 * Resolve the WebSocket endpoint.
 * In production: wait for config, call POST /session via API Gateway, get back wsUrl.
 * In development: use VITE_SANDBOX_WS_HOST/PORT env vars.
 */
async function resolveWsEndpoint(): Promise<string> {
  // Check if endpoint was already set (e.g. by a previous session)
  if (typeof window !== 'undefined' && (window as any).__SANDBOX_WS_ENDPOINT__) {
    return (window as any).__SANDBOX_WS_ENDPOINT__;
  }

  // Wait for /api/config to populate window.ENV
  const configReady = await waitForConfig();

  if (configReady && typeof window !== 'undefined' && window.ENV?.API_GATEWAY_REST_URL) {
    // Retry session creation — auth tokens may not be ready immediately
    // after page load (Cognito Amplify initializes asynchronously).
    const MAX_RETRIES = 5;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { getSessionClient } = await import('~/lib/api/session-client');
        const client = getSessionClient();
        const session = await client.createSession();

        // Store for reconnection and other consumers
        (window as any).__SANDBOX_WS_ENDPOINT__ = session.wsUrl;
        (window as any).__SANDBOX_PREVIEW_DOMAIN__ = session.previewDomain;
        (window as any).__SANDBOX_SESSION_ID__ = session.sessionId;

        logger.info('Sandbox session created:', session.sessionId);
        return session.wsUrl;
      } catch (err) {
        logger.warn(`Session creation attempt ${attempt}/${MAX_RETRIES} failed:`, err);

        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    logger.error('All session creation attempts failed');
  }

  // Development fallback
  const host = import.meta.env.VITE_SANDBOX_WS_HOST || 'localhost';
  const port = import.meta.env.VITE_SANDBOX_WS_PORT || '8080';

  return `ws://${host}:${port}`;
}

/**
 * Resolve auth token for WebSocket connection.
 * Uses Cognito ID token when available.
 */
async function resolveAuthToken(): Promise<string | undefined> {
  if (typeof window !== 'undefined' && (window as any).__SANDBOX_AUTH_TOKEN__) {
    return (window as any).__SANDBOX_AUTH_TOKEN__;
  }

  // Get Cognito token from Amplify
  try {
    const { fetchAuthSession } = await import('aws-amplify/auth');
    const session = await fetchAuthSession();
    const token = session.tokens?.idToken?.toString();

    if (token) {
      (window as any).__SANDBOX_AUTH_TOKEN__ = token;
      return token;
    }
  } catch (err) {
    logger.debug('No Cognito session available for auth token');
  }

  return undefined;
}

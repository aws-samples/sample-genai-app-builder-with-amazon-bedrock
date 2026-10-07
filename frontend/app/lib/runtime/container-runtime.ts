import { WORK_DIR_NAME } from '~/utils/constants';
import { createScopedLogger } from '~/utils/logger';
import { RuntimeConnectionImpl } from './connection';
import { setSessionStatus } from './session-status';
import type { RuntimeConfig, RuntimeConnection } from './types';
import { forgetInviteToken, resolveInviteToken } from './invite-survival';
import { forgetJoinedSession, rememberJoinedSession, resolveJoinedSession } from './joined-session';
import { planEndpointResolution, reconnectableWsUrl } from './endpoint-plan';

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
  setSessionStatus('connecting');

  try {
    // In production, create a session first to get the WebSocket URL
    const wsEndpoint = await resolveWsEndpoint();

    const config: RuntimeConfig = {
      wsEndpoint,
      reconnect: true,
      reconnectInterval: 1000,
      maxReconnectAttempts: 10,
      requestTimeout: 120000,
      pingInterval: 30000,
      refreshEndpoint: refreshWsEndpoint,
    };

    logger.debug('Booting container runtime...', { wsEndpoint });

    const connection = new RuntimeConnectionImpl(config);
    await connection.connect();

    containerRuntimeContext.loaded = true;
    logger.debug('Container runtime connected');

    // Connected, but a joiner's file tree is still empty until the container
    // replays its files. The files store flips this to `ready` on first sync.
    setSessionStatus('syncing');

    await bindContainer(connection);

    return connection;
  } catch (err) {
    setSessionStatus(
      'failed',
      (window as any)?.__SANDBOX_JOINED_SESSION__
        ? 'Could not join the shared session — the invite may have expired.'
        : 'Could not connect to the sandbox.',
    );
    throw err;
  }
}

/**
 * Tell the backend which container answered, so collaborators are routed to the
 * same one.
 *
 * Claiming a sandbox only reserves a task in the session record — the container
 * itself is never told — so until a connection lands, the recorded address is a
 * guess. The sidecar reports its own hostname on connect; passing that back makes
 * the container the authority and lets the routing layer pin every later
 * collaborator to it.
 *
 * Only the owner can bind, and a failure is non-fatal: solo editing already works
 * over the shared route, so this must never block the runtime from coming up.
 */
async function bindContainer(connection: RuntimeConnection): Promise<void> {
  const { sessionId, containerId } = connection.getSession();

  if (!sessionId || !containerId || typeof window === 'undefined') {
    return;
  }

  // A joiner is not the owner and would be refused; the owner has already pinned.
  if ((window as any).__SANDBOX_JOINED_SESSION__) {
    return;
  }

  try {
    const { getSessionClient } = await import('~/lib/api/session-client');
    await getSessionClient().bindContainer(sessionId, containerId);
    logger.debug('Container bound for collaboration', { containerId });
  } catch (err) {
    logger.warn('Could not bind container — collaborators may not reach it:', err);
  }
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
 * Whether a cached endpoint's signed URL still has usable life left.
 *
 * Read purely to decide whether to bother reusing the URL — CloudFront verifies
 * the signature and expiry itself, so a client that misreads this gains nothing.
 * A URL with no CloudFront policy, or one we cannot parse, is treated as stale so
 * the caller re-requests rather than dialling something CloudFront will refuse.
 *
 * The margin covers the round trip plus clock skew: a URL about to expire is
 * not worth trying.
 */
export function isWsUrlFresh(wsUrl: string, marginSeconds = 20): boolean {
  try {
    const policy = new URL(wsUrl).searchParams.get('Policy');

    if (!policy) {
      return false;
    }

    // CloudFront's URL-safe base64: '-' for '+', '_' for '=', '~' for '/'.
    const json = atob(policy.replace(/-/g, '+').replace(/_/g, '=').replace(/~/g, '/'));
    const exp = (JSON.parse(json) as { Statement?: Array<{ Condition?: { DateLessThan?: Record<string, unknown> } }> })
      .Statement?.[0]?.Condition?.DateLessThan?.['AWS:EpochTime'];

    if (typeof exp !== 'number') {
      return false;
    }

    return exp - marginSeconds > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

/**
 * Re-request the WebSocket endpoint so a reconnect carries a fresh signed URL.
 *
 * Signed URLs are deliberately short-lived, and reconnect backoff can outlast one, so
 * a long outage would otherwise leave the client unable to reconnect at all. Asks
 * the API for the current session rather than creating a new one, which would
 * abandon the sandbox the user is working in.
 */
async function refreshWsEndpoint(explicitSessionId?: string): Promise<string | undefined> {
  const sessionId =
    explicitSessionId ?? (typeof window !== 'undefined' ? (window as any).__SANDBOX_SESSION_ID__ : null);

  if (!sessionId) {
    return undefined;
  }

  try {
    const { getSessionClient } = await import('~/lib/api/session-client');
    const status = await getSessionClient().getStatus(sessionId);
    const wsUrl = reconnectableWsUrl(status);

    if (wsUrl) {
      (window as any).__SANDBOX_WS_ENDPOINT__ = wsUrl;
      return wsUrl;
    }

    // A URL was signed, but for a session that is stopping or already stopped —
    // its routing is gone, so dialling it would only time out.
    logger.warn('The sandbox session is no longer running; not reconnecting to it');
  } catch (err) {
    logger.warn('Could not refresh the sandbox endpoint:', err);
  }

  return undefined;
}

/**
 * Extract an invite token from a URL query string (`?join=<token>`).
 *
 * Kept separate from the `window` lookup so the parsing rule — which decides
 * whether a visitor joins someone else's live session or gets a fresh sandbox of
 * their own — can be tested directly. An empty value counts as absent.
 */
export function parseInviteToken(search: string): string | null {
  const token = new URLSearchParams(search).get('join');
  return token && token.length > 0 ? token : null;
}

/**
 * The invite token from the current URL, if any.
 *
 * Read from the live location rather than passed in, because the runtime boots
 * from several entry points and must reach the same decision in all of them.
 */
export function readInviteToken(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }

  // Falls back to a token stashed before an auth redirect: an SSO login round trip
  // returns to `origin + pathname` and loses the query string, so a collaborator
  // whose SSO session had lapsed would arrive with no token at all. See `invite-survival.ts`.
  return resolveInviteToken(window.location.search);
}

/**
 * Resolve the WebSocket endpoint.
 * In production: wait for config, call POST /session via API Gateway, get back wsUrl.
 * In development: use VITE_SANDBOX_WS_HOST/PORT env vars.
 */
async function resolveWsEndpoint(): Promise<string> {
  // An endpoint from earlier in this page's life (e.g. reopening a project) is
  // reusable only while its signed URL is valid. Signed URLs are deliberately
  // short-lived, so a cached URL is usually stale by the time someone navigates
  // back — reusing it blindly produced a connection the container refuses, which
  // looks like the workbench hanging on open. Re-request one instead.
  const cached = typeof window !== 'undefined' ? (window as any).__SANDBOX_WS_ENDPOINT__ : null;
  const heldSessionId = typeof window !== 'undefined' ? (window as any).__SANDBOX_SESSION_ID__ : null;
  const inviteToken = readInviteToken();
  const joinedSessionId = resolveJoinedSession();

  const plan = planEndpointResolution({
    cached,
    urlFresh: Boolean(cached) && isWsUrlFresh(cached),
    sessionId: heldSessionId,
    joinedSessionId,
    hasInviteToken: Boolean(inviteToken),
  });

  if (plan === 'reuse-cached') {
    return cached;
  }

  // Holding a session forbids creating one: `POST /session` retires the caller's
  // current session before claiming a container, so falling through to it here
  // was killing the live sandbox — the reconnect then had no route to reach and
  // timed out for good. Re-sign instead, and fail loudly if that is impossible
  // rather than "recovering" by destroying the user's work.
  if (plan === 'refresh') {
    const refreshed = await refreshWsEndpoint();

    if (refreshed) {
      return refreshed;
    }

    throw new Error('Could not re-establish the sandbox session. Please retry.');
  }

  // A guest whose tab reloaded. Their invite has already been redeemed and
  // forgotten, and nothing page-scoped survived, so `create` would hand them a
  // fresh empty sandbox and drop them out of the session they were invited into —
  // which is what "refreshing breaks the shared session" looked like from the
  // owner's side. Membership is still recorded server-side, so re-sign the
  // session instead.
  //
  // Unlike `refresh` this falls through rather than throwing: the remembered
  // session may legitimately have ended while the tab was closed, and a guest whose
  // shared session is gone should get a sandbox of their own, not an error.
  if (plan === 'rejoin' && joinedSessionId) {
    await waitForConfig();
    await waitForIdentity();

    try {
      const { getSessionClient } = await import('~/lib/api/session-client');
      const status = await getSessionClient().resumeSession(joinedSessionId);
      const wsUrl = reconnectableWsUrl(status);

      if (wsUrl) {
        (window as any).__SANDBOX_WS_ENDPOINT__ = wsUrl;
        (window as any).__SANDBOX_SESSION_ID__ = joinedSessionId;
        // Still a guest, not the owner: this must keep suppressing the owner-only
        // container bind and keep the client going live automatically.
        (window as any).__SANDBOX_JOINED_SESSION__ = true;

        logger.info('Rejoined shared sandbox session after reload:', joinedSessionId);

        return wsUrl;
      }

      logger.warn('The shared session is no longer running; starting a sandbox of your own');
    } catch (err) {
      logger.warn('Could not rejoin the shared sandbox session:', err);
    }

    // Whatever went wrong, retrying it on every later boot in this tab can only
    // fail the same way.
    forgetJoinedSession();
  }

  // Wait for /api/config to populate window.ENV
  const configReady = await waitForConfig();

  if (configReady && typeof window !== 'undefined' && window.ENV?.API_GATEWAY_REST_URL) {
    // Creating a session needs an authenticated identity, and this runs during page
    // load while Amplify is still hydrating. Wait for identity FIRST rather than
    // burning the retry budget on a race we can simply avoid.
    await waitForIdentity();

    const MAX_RETRIES = 5;

    // Back off from a short first delay rather than a flat 2s. The common cause
    // of a first-attempt miss is auth still hydrating, which clears in a few
    // hundred ms — so retrying quickly makes the happy path feel instant, while
    // the growth still gives a genuinely slow backend room to recover.
    const retryDelayMs = (attempt: number) => Math.min(400 * 2 ** (attempt - 1), 3000);

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { getSessionClient } = await import('~/lib/api/session-client');
        const client = getSessionClient();
        // An invited collaborator adopts the inviter's session; creating one
        // would put them in their own empty container instead.
        const session = inviteToken
          ? await client.joinSession(inviteToken)
          : await client.createSession();

        // Store for reconnection and other consumers
        (window as any).__SANDBOX_WS_ENDPOINT__ = session.wsUrl;
        (window as any).__SANDBOX_PREVIEW_DOMAIN__ = session.previewDomain;
        (window as any).__SANDBOX_SESSION_ID__ = session.sessionId;

        // Flag the joined case so a collaborator's client can go live
        // automatically rather than waiting to be told to.
        (window as any).__SANDBOX_JOINED_SESSION__ = Boolean(inviteToken);

        // The project the invite granted, so the joiner can load the conversation
        // behind the shared files instead of an empty chat panel.
        if ((session as { projectId?: string }).projectId) {
          (window as any).__SHARED_PROJECT_ID__ = (session as { projectId?: string }).projectId;
        }

        if (inviteToken) {
          // Redeemed, so stop remembering it. Otherwise every later navigation in
          // this tab still looks like an invite and would push the user back into
          // the shared session after they had moved on.
          forgetInviteToken();

          // Remember the session itself, though: a reload has no token left to
          // redeem and no page state, so this is the only thing that keeps the
          // guest in the shared sandbox rather than creating an empty one.
          rememberJoinedSession(session.sessionId);
        }

        logger.info(
          inviteToken ? 'Joined shared sandbox session:' : 'Sandbox session created:',
          session.sessionId,
        );
        return session.wsUrl;
      } catch (err) {
        const action = inviteToken ? 'Session join' : 'Session creation';
        logger.warn(`${action} attempt ${attempt}/${MAX_RETRIES} failed:`, err);

        if (attempt < MAX_RETRIES) {
          await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
        }
      }
    }

    logger.error(inviteToken ? 'All session join attempts failed' : 'All session creation attempts failed');

    // Do NOT fall through to the local dev endpoint. In a deployed environment
    // nothing is listening on localhost, so returning it produced a connection
    // that could only fail — and because the boot promise was awaited by every
    // consumer, that surfaced as a project whose every action failed with no
    // explanation. Throwing lets the caller retry and lets the UI say what is
    // wrong.
    throw new Error(
      inviteToken
        ? 'Could not join the shared sandbox session. The invite may have expired.'
        : 'Could not start a sandbox session. Please retry.',
    );
  }

  // Local development only: no API Gateway configured, so talk to a sidecar
  // running on the developer's machine.
  const host = import.meta.env.VITE_SANDBOX_WS_HOST || 'localhost';
  const port = import.meta.env.VITE_SANDBOX_WS_PORT || '8080';

  return `ws://${host}:${port}`;
}

/**
 * Wait until an authenticated identity is resolvable, or give up.
 *
 * Cognito hydrates asynchronously after page load, so the first attempt to create
 * a sandbox session can arrive before there is any identity to attribute it to.
 * Returns false on timeout rather than throwing: the caller's retry loop reports
 * the failure with better context.
 */
async function waitForIdentity(timeoutMs = 6000): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const { getCurrentUserId } = await import('~/lib/api/user-id');
      if (await getCurrentUserId()) {
        return true;
      }
    } catch {
      // Auth not ready yet — fall through to the delay and try again.
    }

    // Poll tightly: identity usually resolves within a few hundred ms, and a
    // shorter interval means the session call fires the moment it does rather
    // than sitting idle for the rest of a coarse tick.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  logger.warn('Timed out waiting for an authenticated identity before booting the sandbox');
  return false;
}

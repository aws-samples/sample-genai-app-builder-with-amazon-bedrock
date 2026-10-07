/**
 * How to obtain a WebSocket endpoint for the sandbox.
 *
 * - `reuse-cached` — the URL in hand still carries a usable signed URL.
 * - `refresh` — re-sign the session we already hold (`GET /session/{id}`).
 * - `rejoin` — re-sign a session this tab joined before a reload, falling back
 *   to `create` if it is gone (`GET /session/{id}`).
 * - `create` — ask for a new session, or redeem an invite (`POST /session`).
 */
export type EndpointPlan = 'reuse-cached' | 'refresh' | 'rejoin' | 'create';

export interface EndpointState {
  /** The endpoint from earlier in this page's life, if any. */
  cached: string | null | undefined;
  /** Whether `cached`'s signed URL has enough life left to be worth dialling. */
  urlFresh: boolean;
  /** The session this page already holds, if any. */
  sessionId: string | null | undefined;
  /**
   * A session this tab joined on an earlier page load, if any. Survives a reload;
   * see `joined-session.ts`.
   */
  joinedSessionId?: string | null;
  /** Whether the current visit still carries an invite token to redeem. */
  hasInviteToken?: boolean;
}

/**
 * Decide how to get a connectable endpoint.
 *
 * The load-bearing rule is that holding a session forbids creating one.
 * `POST /session` is not additive: the session manager retires the caller's
 * existing session first — status → STOPPED, claim lock deleted, ALB routing
 * released — so a client that creates a session while already holding one
 * destroys the very sandbox it is working in. That produced the observed trio of
 * a 409 on the next heartbeat, a reconnect that could never succeed (its route no
 * longer existed) and a preview 503 once the container wiped the workdir.
 *
 * So a stale signed URL is only ever a reason to re-sign, never a reason to start
 * over. Creating is reserved for having no session at all.
 *
 * A remembered *joined* session is the same rule one page load removed: a guest's
 * reload has no page state left, so without this they would create a sandbox of
 * their own and vanish from the session they were invited into. It is a separate
 * plan from `refresh` because the two fail differently — a held session that cannot
 * be re-signed must fail loudly, while a remembered session that has since ended
 * legitimately leaves the guest with their own sandbox. An invite token still in
 * hand wins over it, so following a second invite does not resurrect the first
 * session.
 */
export function planEndpointResolution({
  cached,
  urlFresh,
  sessionId,
  joinedSessionId,
  hasInviteToken,
}: EndpointState): EndpointPlan {
  if (cached && urlFresh) {
    return 'reuse-cached';
  }

  if (sessionId) {
    return 'refresh';
  }

  if (joinedSessionId && !hasInviteToken) {
    return 'rejoin';
  }

  return 'create';
}

/** Shape of `GET /session/{id}`: the record, plus a URL signed for this caller. */
export interface SessionLookup {
  session?: { status?: string };
  wsUrl?: string;
}

/**
 * The endpoint from a session lookup, but only if it is worth dialling.
 *
 * `GET /session/{id}` signs a URL unconditionally, so `wsUrl` is present even
 * for a session the backend has stopped and whose routing it has released.
 * Connecting to one cannot succeed and cannot fail fast either — it fails by
 * timing out — so a stopped session has to be recognised here and reported as
 * gone.
 *
 * A response with no status is trusted: refusing on missing information would
 * turn an unexpected payload into an unreconnectable client.
 */
export function reconnectableWsUrl({ session, wsUrl }: SessionLookup): string | undefined {
  if (!wsUrl) {
    return undefined;
  }

  const status = session?.status;

  return status === 'STOPPING' || status === 'STOPPED' ? undefined : wsUrl;
}

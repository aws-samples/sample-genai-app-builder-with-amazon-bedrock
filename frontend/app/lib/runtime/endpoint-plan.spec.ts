import { describe, it, expect } from 'vitest';
import { planEndpointResolution, reconnectableWsUrl } from './endpoint-plan';

/**
 * Creating a sandbox session is destructive to the caller's *own* existing one:
 * `handleCreateSession` retires the user's active session (status → STOPPED),
 * drops its claim lock and releases its ALB routing before claiming a container
 * for the new one. So a client that already holds a session must never reach for
 * `POST /session` — doing so kills the socket it is trying to keep, which is what
 * turned a stale signed URL into "Reconnect failed: Connection timeout" plus a 409 on
 * the next heartbeat.
 *
 * The decision is extracted here so the rule can be asserted directly, rather
 * than inferred from the order of branches in `resolveWsEndpoint`.
 */
describe('planEndpointResolution', () => {
  it('reuses a cached endpoint while its signed URL is still fresh', () => {
    expect(
      planEndpointResolution({ cached: 'wss://x/ws/s?Signature=t', urlFresh: true, sessionId: 's' }),
    ).toBe('reuse-cached');
  });

  it('re-signs an existing session rather than creating one, when the cached signed URL is stale', () => {
    expect(
      planEndpointResolution({ cached: 'wss://x/ws/s?Signature=t', urlFresh: false, sessionId: 's' }),
    ).toBe('refresh');
  });

  it('never creates a session while one is already held, even with no cached endpoint', () => {
    // The regression: losing the cached URL (or holding a stale one) used to fall
    // through to createSession, retiring the live session server-side.
    expect(planEndpointResolution({ cached: null, urlFresh: false, sessionId: 's' })).toBe('refresh');
  });

  it('creates a session only when none is held', () => {
    expect(planEndpointResolution({ cached: null, urlFresh: false, sessionId: null })).toBe('create');
  });

  it('ignores a cached endpoint that belongs to no known session', () => {
    // Nothing to refresh against, so creating is the only option.
    expect(
      planEndpointResolution({ cached: 'wss://x/ws/s?Signature=t', urlFresh: false, sessionId: null }),
    ).toBe('create');
  });

  it('prefers a fresh cached signed URL even when no session id is recorded', () => {
    expect(
      planEndpointResolution({ cached: 'wss://x/ws/s?Signature=t', urlFresh: true, sessionId: null }),
    ).toBe('reuse-cached');
  });

  /**
   * A reload wipes every page-scoped trace of a guest's membership, and the invite
   * token is deliberately forgotten once redeemed — so without a remembered
   * session id the guest looks like a first-time visitor and is handed a brand-new
   * empty sandbox, silently dropping out of the session they were invited into.
   *
   * Rejoining is kept distinct from refreshing because the two fail differently: a
   * held session that cannot be re-signed must fail loudly (falling through to
   * create is what retired the live sandbox), whereas a remembered session that has
   * since ended legitimately leaves the guest with a sandbox of their own.
   */
  describe('a guest reloading after their invite was redeemed', () => {
    it('rejoins the session it was invited into rather than creating one', () => {
      expect(
        planEndpointResolution({
          cached: null,
          urlFresh: false,
          sessionId: null,
          joinedSessionId: 'sess-shared',
        }),
      ).toBe('rejoin');
    });

    it('prefers the session this page already holds over a remembered one', () => {
      expect(
        planEndpointResolution({
          cached: null,
          urlFresh: false,
          sessionId: 'sess-held',
          joinedSessionId: 'sess-shared',
        }),
      ).toBe('refresh');
    });

    it('redeems an invite token still on the URL instead of rejoining a stale session', () => {
      // The token names the session to join and grants its project; honouring a
      // remembered id would put a guest following a second invite into the first
      // session.
      expect(
        planEndpointResolution({
          cached: null,
          urlFresh: false,
          sessionId: null,
          joinedSessionId: 'sess-first',
          hasInviteToken: true,
        }),
      ).toBe('create');
    });

    it('still reuses a cached endpoint whose signed URL is fresh', () => {
      expect(
        planEndpointResolution({
          cached: 'wss://x/ws/s?Signature=t',
          urlFresh: true,
          sessionId: null,
          joinedSessionId: 'sess-shared',
        }),
      ).toBe('reuse-cached');
    });
  });
});

/**
 * `GET /session/{id}` answers with a freshly-signed URL regardless of session
 * status, so a client that only checks for `wsUrl` will happily dial a session the
 * backend has already stopped and whose ALB routing has been released. Nothing
 * answers, so each attempt burns the full 120s connect timeout — ten of those is
 * twenty minutes of a workbench that looks merely slow. Recognising a dead session
 * lets the UI say so instead.
 */
describe('reconnectableWsUrl', () => {
  const wsUrl = 'wss://x/ws/s?Signature=t';

  it('returns the URL for a session that is still active', () => {
    expect(reconnectableWsUrl({ session: { status: 'ACTIVE' }, wsUrl })).toBe(wsUrl);
  });

  it('refuses a stopped session even though it was handed a signed URL', () => {
    expect(reconnectableWsUrl({ session: { status: 'STOPPED' }, wsUrl })).toBeUndefined();
  });

  it('refuses a session that is on its way down', () => {
    expect(reconnectableWsUrl({ session: { status: 'STOPPING' }, wsUrl })).toBeUndefined();
  });

  it('accepts a session that has not finished starting, so a boot race can still connect', () => {
    expect(reconnectableWsUrl({ session: { status: 'PENDING' }, wsUrl })).toBe(wsUrl);
  });

  it('returns undefined when no URL was supplied', () => {
    expect(reconnectableWsUrl({ session: { status: 'ACTIVE' } })).toBeUndefined();
  });

  it('trusts the URL when the response carries no status, rather than blocking recovery', () => {
    // Older deployments answered without the session envelope; refusing here would
    // make a reconnect impossible against them.
    expect(reconnectableWsUrl({ wsUrl })).toBe(wsUrl);
  });
});

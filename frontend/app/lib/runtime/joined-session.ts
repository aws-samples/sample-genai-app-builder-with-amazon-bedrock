/**
 * Remembering which session a guest was invited into, across a page reload.
 *
 * Everything that ties a collaborator to someone else's sandbox is page-scoped:
 * `window.__SANDBOX_SESSION_ID__`, the cached WebSocket endpoint, and the `?join=`
 * token — which `invite-survival.ts` deliberately forgets the moment it is
 * redeemed, so a later navigation in the same tab does not drag the user back into
 * a session they had finished with. A reload therefore leaves a guest looking like
 * a first-time visitor: the runtime creates them a brand-new empty sandbox, and
 * from the owner's side the collaborator simply disappears mid-session.
 *
 * Storing the session id closes that without re-redeeming an invite. It is not a
 * capability — membership lives in the session record and is re-checked on every
 * request, so a remembered id that no longer belongs to this user is refused
 * server-side rather than honoured.
 *
 * `sessionStorage` rather than `localStorage`, deliberately: the memory should
 * cover a reload of *this* tab and go no further. A session lasts two hours and an
 * invite thirty minutes, so resurrecting a months-old id in a new tab would only
 * ever produce a failed lookup.
 */
const STORAGE_KEY = 'bv_joined_session';

/**
 * Run `fn`, returning `fallback` if storage is unavailable.
 *
 * Private-mode and hardened browser configurations throw on `sessionStorage`
 * access rather than returning null, and losing the rejoin is a far better outcome
 * than a workbench that will not boot.
 */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Remember that this browser belongs to `sessionId`, having redeemed an invite. */
export function rememberJoinedSession(sessionId: string): void {
  if (!sessionId) {
    return;
  }

  safely(() => sessionStorage.setItem(STORAGE_KEY, sessionId), undefined);
}

/** The session this tab joined on an earlier page load, if any. */
export function resolveJoinedSession(): string | null {
  return safely(() => sessionStorage.getItem(STORAGE_KEY), null) || null;
}

/**
 * Stop remembering the joined session.
 *
 * Called when a rejoin is refused — the session has ended, or this user is no
 * longer a member — so the next load asks for a sandbox of its own instead of
 * retrying a lookup that can only fail.
 */
export function forgetJoinedSession(): void {
  safely(() => sessionStorage.removeItem(STORAGE_KEY), undefined);
}

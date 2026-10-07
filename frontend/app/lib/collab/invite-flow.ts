/**
 * Minting an invite without waiting for the live session to come up.
 *
 * The invite endpoint itself is quick — the prod session-manager Lambda answers
 * in 230-270ms. What made "Invite" feel slow was the client: it awaited
 * `enableCollab()` first, and that awaits `getConnection()`, i.e. the whole
 * sandbox boot. On a cold project that is 30-70 seconds of apparently nothing
 * happening after a click.
 *
 * Going live before handing out the link is still the right default — it means
 * the inviter is already present when their guest arrives, rather than the guest
 * landing in an empty-looking session. But it does not have to be on the critical
 * path: the invite only needs a session id, and the collaboration provider can
 * finish attaching while the link is already on the clipboard.
 */

export interface InviteFlowDeps {
  /** Whether the collaboration provider is already attached. */
  isCollabEnabled: () => boolean;

  /** Attach the collaboration provider. Resolves when presence is live. */
  enableCollab: () => Promise<void>;

  /** The current sandbox session id, if one exists yet. */
  getSessionId: () => string | undefined;

  /**
   * Ensure a sandbox session exists.
   *
   * Only awaited when there is no session id yet — an invite has to point at a
   * session, so that wait is irreducible.
   */
  ensureConnected: () => Promise<void>;

  createInvite: (sessionId: string | undefined) => Promise<{ token: string }>;

  /** Report a background failure without failing the invite. */
  onBackgroundError?: (error: unknown) => void;
}

/**
 * Mint an invite token, going live in the background rather than ahead of it.
 *
 * Returns as soon as the token exists. When the session is already up — the
 * common case, since you invite someone into a project you are working in — this
 * is one API call rather than a full sandbox boot.
 */
export async function mintInviteToken(deps: InviteFlowDeps): Promise<string> {
  const startCollabInBackground = () => {
    if (deps.isCollabEnabled()) {
      return;
    }

    // Deliberately not awaited: presence attaching a moment after the link is
    // copied is invisible to the user, whereas waiting for it is not.
    deps.enableCollab().catch((error) => deps.onBackgroundError?.(error));
  };

  let sessionId = deps.getSessionId();

  if (!sessionId) {
    // No session to invite anyone into yet, so this wait cannot be avoided.
    await deps.ensureConnected();
    sessionId = deps.getSessionId();
  }

  startCollabInBackground();

  const { token } = await deps.createInvite(sessionId);

  return token;
}

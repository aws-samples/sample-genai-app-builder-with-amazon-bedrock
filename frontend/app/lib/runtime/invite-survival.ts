/**
 * Keeping an invite token across a full-page auth redirect.
 *
 * The token lives in `?join=` on the URL a collaborator opens. That is fine when
 * authentication does not navigate — Cognito's hosted form posts back to the same
 * URL, and an SSO provider's usual path is a silent token fetch. But when the SSO
 * session is missing or expired, the provider navigates to its login page and
 * returns to `origin + pathname`, dropping the query string. The collaborator then arrives with no token, the invite is never
 * redeemed, and they get a fresh sandbox of their own instead of the session they
 * were invited to — with nothing on screen to say why.
 *
 * Stashing the token before the redirect and reading it back afterwards closes
 * that hole without depending on the auth provider's redirect URI, which is
 * constrained by what the identity provider will accept.
 */
const STORAGE_KEY = 'bv_pending_invite';

/** Read `?join=` out of a query string. */
function tokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get('join');

  return token && token.length > 0 ? token : null;
}

/**
 * Run `fn`, returning `fallback` if storage is unavailable.
 *
 * Private-mode and hardened browser configurations make `sessionStorage` throw on
 * access rather than return null, and losing an invite is a far better outcome
 * than a workbench that will not boot.
 */
function safely<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Remember the invite token in the current URL, if there is one.
 *
 * Call before any navigation that may lose the query string.
 */
export function rememberInviteToken(search: string): void {
  const token = tokenFromSearch(search);

  if (!token) {
    return;
  }

  safely(() => sessionStorage.setItem(STORAGE_KEY, token), undefined);
}

/**
 * The invite token for this visit: the URL's if present, else one remembered
 * from before a redirect.
 *
 * The URL wins, so following a second invite in the same tab does not resurrect
 * the first.
 */
export function resolveInviteToken(search: string): string | null {
  const fromUrl = tokenFromSearch(search);

  if (fromUrl) {
    return fromUrl;
  }

  return safely(() => sessionStorage.getItem(STORAGE_KEY), null) || null;
}

/**
 * Drop the remembered token once it has been redeemed.
 *
 * Without this every later navigation in the tab still looks like an invite, so a
 * user who had finished joining would be pushed back into someone else's session.
 */
export function forgetInviteToken(): void {
  safely(() => sessionStorage.removeItem(STORAGE_KEY), undefined);
}

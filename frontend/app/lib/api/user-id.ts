import { fetchAuthSession } from 'aws-amplify/auth';

/**
 * Resolve the current caller's identity (Cognito `sub`).
 *
 * Used to scope server-side DDB lookups (brand templates, sessions, etc.)
 * without having to forward the full ID token in a signed header. The
 * backend trusts this value because the Function URL / API Gateway auth
 * layer already verified the caller.
 *
 * Returns null if no identity can be resolved — callers should treat that
 * as "proceed without user-scoped data" rather than fatal.
 */
export async function getCurrentUserId(): Promise<string | null> {
  if (typeof window === 'undefined') return null;

  try {
    const session = await fetchAuthSession();
    const payload = session.tokens?.idToken?.payload;
    const sub = payload?.sub;
    if (typeof sub === 'string') return sub;
    const email = payload?.email;
    if (typeof email === 'string') return email;
  } catch {
    // fall through
  }

  return null;
}

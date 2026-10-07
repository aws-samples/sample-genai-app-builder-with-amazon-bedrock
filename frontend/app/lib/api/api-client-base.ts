import { fetchAuthSession } from 'aws-amplify/auth';

export abstract class ApiClientBase {
  /**
   * Auth headers for an API Gateway call: the Cognito id-token as a Bearer token.
   *
   * Pass `forceRefresh` to mint a new token rather than reuse the cached one —
   * callers use this to recover from a short-lived id-token that expired while
   * the tab stayed open. Throws rather than emitting `Bearer undefined`, which
   * the authorizer would reject with an unhelpful 401.
   */
  protected async getHeaders(options: { forceRefresh?: boolean } = {}): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this.getIdToken(options)}`,
    };
  }

  protected async getIdToken(options: { forceRefresh?: boolean } = {}): Promise<string> {
    const session = await fetchAuthSession({ forceRefresh: options.forceRefresh });
    const idToken = session.tokens?.idToken?.toString();

    if (!idToken) {
      throw new Error('No id-token available — the user is not signed in');
    }

    return idToken;
  }
}

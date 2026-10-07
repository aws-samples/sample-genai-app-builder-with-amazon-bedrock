import { ApiClientBase } from './api-client-base';

export interface EnhancementRequest {
  message: string;
  enableTemplate?: boolean;
  modelId?: string;
}

/**
 * POST the prompt to /api/enhancer with the caller's bearer token.
 *
 * The enhancer invokes the model, so the gateway runs the REQUEST authorizer on
 * it and the route refuses calls without a verified identity. The id-token is
 * short-lived, so a 401/403 is retried once with a force-refreshed token, the
 * same recovery the session client uses.
 */
class EnhancerClient extends ApiClientBase {
  async request(body: EnhancementRequest, signal?: AbortSignal): Promise<Response> {
    const send = async (forceRefresh: boolean): Promise<Response> => {
      const authHeaders = await this.getHeaders(forceRefresh ? { forceRefresh: true } : undefined);

      return fetch('/api/enhancer', {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    };

    const response = await send(false);

    if (response.status === 401 || response.status === 403) {
      return send(true);
    }

    return response;
  }
}

const client = new EnhancerClient();

export function requestEnhancement(body: EnhancementRequest, signal?: AbortSignal): Promise<Response> {
  return client.request(body, signal);
}

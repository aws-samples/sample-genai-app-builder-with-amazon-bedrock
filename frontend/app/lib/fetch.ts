type CommonRequest = Omit<RequestInit, 'body'> & { body?: URLSearchParams };

export async function request(url: string, init?: CommonRequest) {
  if (import.meta.env.DEV) {
    const nodeFetch = await import('node-fetch');
    const https = await import('node:https');

    // Use proper TLS verification with default settings
    const agent = url.startsWith('https') ? new https.Agent() : undefined;

    return nodeFetch.default(url, { ...init, agent });
  }

  return fetch(url, init);
}

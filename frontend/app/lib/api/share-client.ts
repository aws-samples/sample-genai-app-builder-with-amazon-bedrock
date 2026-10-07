import { ApiClientBase } from './api-client-base';

interface ShareCreateResponse {
  shareId: string;
  uploadUrls: string[];
  fileMap: { file: string; url: string; contentType?: string }[];
}

interface ShareConfirmResponse {
  url: string;
}

interface ShareListResponse {
  shares: {
    shareId: string;
    title: string;
    createdAt: number;
    expiresAt: number;
    url: string;
  }[];
}

export class ShareClient extends ApiClientBase {
  private getRestApiUrl(): string {
    if (typeof window !== 'undefined' && window.location.origin) {
      return window.location.origin;
    }

    const url = window.ENV?.API_GATEWAY_REST_URL;

    if (!url) {
      throw new Error('API_GATEWAY_REST_URL not configured. Check /api/config endpoint.');
    }

    return url.endsWith('/') ? url.slice(0, -1) : url;
  }

  async createShare(title: string, files: string[]): Promise<ShareCreateResponse> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();
    const response = await fetch(`${baseUrl}/share`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, files }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create share: ${response.status}`);
    }

    return response.json() as Promise<ShareCreateResponse>;
  }

  async confirmShare(shareId: string, title: string): Promise<ShareConfirmResponse> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();
    const response = await fetch(`${baseUrl}/share`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'confirm', shareId, title }),
    });

    if (!response.ok) {
      throw new Error(`Failed to confirm share: ${response.status}`);
    }

    return response.json() as Promise<ShareConfirmResponse>;
  }

  async listShares(): Promise<ShareListResponse> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();
    const response = await fetch(`${baseUrl}/share`, { method: 'GET', headers });

    if (!response.ok) {
      throw new Error(`Failed to list shares: ${response.status}`);
    }

    return response.json() as Promise<ShareListResponse>;
  }

  async deleteShare(shareId: string): Promise<void> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();
    const response = await fetch(`${baseUrl}/share/${shareId}`, { method: 'DELETE', headers });

    if (!response.ok) {
      throw new Error(`Failed to delete share: ${response.status}`);
    }
  }

  async uploadFile(presignedUrl: string, content: string | Uint8Array, contentType?: string): Promise<void> {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;

    let response: Response;

    try {
      /**
       * Without an explicit Content-Type, S3 stores the object as
       * binary/octet-stream and the shared page downloads instead of rendering.
       */
      response = await fetch(presignedUrl, {
        method: 'PUT',
        body,
        ...(contentType ? { headers: { 'Content-Type': contentType } } : {}),
      });
    } catch (err) {
      /**
       * A blocked CORS preflight rejects fetch with a TypeError rather than
       * returning a response, so it never reached the status check below and
       * surfaced as an opaque failure. Translate it into a clear, actionable
       * message — the bucket needs a CORS rule allowing PUT from this origin.
       */
      throw new Error(
        `Upload was blocked by the browser (likely a CORS/network error on the share bucket): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    if (!response.ok) {
      throw new Error(`Failed to upload file: ${response.status}`);
    }
  }
}

let shareClient: ShareClient | null = null;

export function getShareClient(): ShareClient {
  if (!shareClient) {
    shareClient = new ShareClient();
  }

  return shareClient;
}

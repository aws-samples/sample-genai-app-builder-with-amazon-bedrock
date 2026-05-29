import { ApiClientBase } from './api-client-base';

interface ShareCreateResponse {
  shareId: string;
  uploadUrls: string[];
  fileMap: { file: string; url: string }[];
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
    if (!response.ok) throw new Error(`Failed to create share: ${response.status}`);
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
    if (!response.ok) throw new Error(`Failed to confirm share: ${response.status}`);
    return response.json() as Promise<ShareConfirmResponse>;
  }

  async listShares(): Promise<ShareListResponse> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();
    const response = await fetch(`${baseUrl}/share`, { method: 'GET', headers });
    if (!response.ok) throw new Error(`Failed to list shares: ${response.status}`);
    return response.json() as Promise<ShareListResponse>;
  }

  async deleteShare(shareId: string): Promise<void> {
    const baseUrl = this.getRestApiUrl();
    const headers = await this.getHeaders();
    const response = await fetch(`${baseUrl}/share/${shareId}`, { method: 'DELETE', headers });
    if (!response.ok) throw new Error(`Failed to delete share: ${response.status}`);
  }

  async uploadFile(presignedUrl: string, content: string | Uint8Array): Promise<void> {
    const body = typeof content === 'string' ? new TextEncoder().encode(content) : content;
    const response = await fetch(presignedUrl, { method: 'PUT', body });
    if (!response.ok) throw new Error(`Failed to upload file: ${response.status}`);
  }
}

let shareClient: ShareClient | null = null;

export function getShareClient(): ShareClient {
  if (!shareClient) {
    shareClient = new ShareClient();
  }

  return shareClient;
}

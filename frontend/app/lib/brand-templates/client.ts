import { ApiClientBase } from '~/lib/api/api-client-base';
import type {
  BrandTemplate,
  BrandTemplateSummary,
  ExtractionError,
  ExtractionProgress,
} from '~/types/brandTemplate';

/**
 * HTTP client for the `/v1/brand-templates/*` API. Matches the Cognito-authed
 * Bearer-token pattern used by `ShareClient` — the same Remix/API-Gateway
 * chain, no SigV4 dance required.
 */

export interface UploadsBundle {
  jobId: string;
  uploads: Array<{ url: string; s3Key: string }>;
}

export interface CreateSkillResponse {
  skillId: string;
  jobId: string;
  status: 'processing';
}

export interface StatusResponse {
  status: 'processing' | 'ready' | 'failed';
  skillId?: string;
  progress?: ExtractionProgress;
  error?: ExtractionError;
}

export interface ListSkillsResponse {
  skills: BrandTemplateSummary[];
}

export interface CreateFromImagesInput {
  name: string;
  description?: string;
  tags?: string[];
  files: File[];
}

export interface CreateFromUrlInput {
  name: string;
  description?: string;
  tags?: string[];
  url: string;
}

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: ExtractionProgress | undefined) => void;
}

export class BrandTemplatesClient extends ApiClientBase {
  private baseUrl(): string {
    const url = window.ENV?.API_GATEWAY_REST_URL;
    if (!url) {
      throw new Error('API_GATEWAY_REST_URL not configured. Check /api/config endpoint.');
    }
    const trimmed = url.endsWith('/') ? url.slice(0, -1) : url;
    return `${trimmed}/v1/brand-templates`;
  }

  async listSkills(): Promise<BrandTemplateSummary[]> {
    const headers = await this.getHeaders();
    const response = await fetch(this.baseUrl(), { method: 'GET', headers });
    if (!response.ok) {
      throw new Error(`Failed to list brand templates: ${response.status}`);
    }
    const body = (await response.json()) as ListSkillsResponse;
    return body.skills ?? [];
  }

  async getSkill(skillId: string): Promise<BrandTemplate> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl()}/${encodeURIComponent(skillId)}`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch brand template: ${response.status}`);
    }
    return response.json() as Promise<BrandTemplate>;
  }

  async patchSkill(
    skillId: string,
    patch: Pick<Partial<BrandTemplate>, 'name' | 'description' | 'tags'>,
  ): Promise<BrandTemplate> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl()}/${encodeURIComponent(skillId)}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (!response.ok) {
      throw new Error(`Failed to update brand template: ${response.status}`);
    }
    return response.json() as Promise<BrandTemplate>;
  }

  async deleteSkill(skillId: string): Promise<void> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl()}/${encodeURIComponent(skillId)}`, {
      method: 'DELETE',
      headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to delete brand template: ${response.status}`);
    }
  }

  async exportSkill(skillId: string): Promise<Blob> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl()}/${encodeURIComponent(skillId)}/export`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to export brand template: ${response.status}`);
    }
    return response.blob();
  }

  async getStatus(jobId: string): Promise<StatusResponse> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl()}/status/${encodeURIComponent(jobId)}`, {
      method: 'GET',
      headers,
    });
    if (!response.ok) {
      throw new Error(`Failed to get extraction status: ${response.status}`);
    }
    return response.json() as Promise<StatusResponse>;
  }

  async createFromImages(input: CreateFromImagesInput): Promise<CreateSkillResponse> {
    if (input.files.length < 1 || input.files.length > 5) {
      throw new Error('Upload 1 to 5 images per skill.');
    }

    const uploads = await this.requestUploadUrls(
      input.files.map((f) => f.name),
      input.files.map((f) => f.type || 'application/octet-stream'),
    );

    await Promise.all(
      uploads.uploads.map((slot, idx) =>
        this.putFile(slot.url, input.files[idx]),
      ),
    );

    return this.postCreate({
      name: input.name,
      description: input.description,
      tags: input.tags,
      source: 'images',
      jobId: uploads.jobId,
      s3Keys: uploads.uploads.map((u) => u.s3Key),
    });
  }

  async createFromUrl(input: CreateFromUrlInput): Promise<CreateSkillResponse> {
    return this.postCreate({
      name: input.name,
      description: input.description,
      tags: input.tags,
      source: 'url',
      url: input.url,
    });
  }

  async pollUntilDone(
    jobId: string,
    options: PollOptions = {},
  ): Promise<{ skillId: string; skill: BrandTemplate }> {
    const intervalMs = options.intervalMs ?? 3000;
    // Match the Lambda's 10-min timeout — extraction can chain up to 3
    // Bedrock multimodal calls plus URL/CSS fetches. A shorter cap here
    // would surface "Timed out" while the backend is still working fine.
    const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    const started = Date.now();

    while (true) {
      if (options.signal?.aborted) {
        throw new DOMException('Polling aborted', 'AbortError');
      }

      const status = await this.getStatus(jobId);
      options.onProgress?.(status.progress);

      if (status.status === 'ready' && status.skillId) {
        const skill = await this.getSkill(status.skillId);
        return { skillId: status.skillId, skill };
      }

      if (status.status === 'failed') {
        throw new Error(
          status.error?.message ?? 'Brand template extraction failed.',
        );
      }

      if (Date.now() - started > timeoutMs) {
        throw new Error('Timed out waiting for extraction to complete.');
      }

      await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  // ---- private helpers --------------------------------------------------

  private async requestUploadUrls(
    filenames: string[],
    contentTypes: string[],
  ): Promise<UploadsBundle> {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl()}/upload-urls`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filenames, contentTypes }),
    });
    if (!response.ok) {
      throw new Error(`Failed to request upload URLs: ${response.status}`);
    }
    return response.json() as Promise<UploadsBundle>;
  }

  private async putFile(presignedUrl: string, file: File): Promise<void> {
    const response = await fetch(presignedUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (!response.ok) {
      throw new Error(`Failed to upload ${file.name}: ${response.status}`);
    }
  }

  private async postCreate(body: Record<string, unknown>): Promise<CreateSkillResponse> {
    const headers = await this.getHeaders();
    const response = await fetch(this.baseUrl(), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status === 400) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(data.error ?? 'Invalid request.');
    }
    if (!response.ok) {
      throw new Error(`Failed to create brand template: ${response.status}`);
    }
    return response.json() as Promise<CreateSkillResponse>;
  }
}

let singleton: BrandTemplatesClient | null = null;

export function getBrandTemplatesClient(): BrandTemplatesClient {
  if (!singleton) {
    singleton = new BrandTemplatesClient();
  }
  return singleton;
}

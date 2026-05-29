export interface FileAttachment {
  id: string;
  type: 'document' | 'image';
  file: File;
  name: string;
  size: number;
  mimeType: string;
  status: 'pending' | 'processing' | 'ready' | 'error';
  extractedText?: string;
  base64Data?: string;
  base64MediaType?: string;
  error?: string;
}

export interface AttachmentMeta {
  name: string;
  size: number;
  type: 'document' | 'image';
  mimeType: string;
  thumbnailDataUrl?: string;
}

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
] as const;

export const IMAGE_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
] as const;

export const DOCUMENT_EXTENSIONS = ['.pdf', '.docx', '.md'] as const;
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const;

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_DOCUMENTS = 5;
export const MAX_IMAGES = 5;

export const DOCUMENT_ACCEPT = '.pdf,.docx,.md';
export const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp';

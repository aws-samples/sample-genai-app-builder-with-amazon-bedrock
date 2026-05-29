import {
  type AttachmentMeta,
  type ContentBlock,
  type FileAttachment,
  DOCUMENT_MIME_TYPES,
  IMAGE_MIME_TYPES,
  MAX_FILE_SIZE,
  MAX_DOCUMENTS,
  MAX_IMAGES,
} from '~/types/attachment';

export function classifyFile(file: File): 'document' | 'image' | null {
  if ((DOCUMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'document';
  }
  if (file.type === 'text/plain' && file.name.endsWith('.md')) {
    return 'document';
  }
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return 'image';
  }
  return null;
}

export function validateFile(
  file: File,
  currentDocCount: number,
  currentImageCount: number,
): { valid: true } | { valid: false; error: string } {
  const fileType = classifyFile(file);

  if (!fileType) {
    return {
      valid: false,
      error: 'Unsupported file type. Supported: PDF, Word, Markdown, and images (.png, .jpg, .gif, .webp)',
    };
  }

  if (file.size > MAX_FILE_SIZE) {
    return { valid: false, error: `File exceeds 10MB limit: ${file.name}` };
  }

  if (fileType === 'document' && currentDocCount >= MAX_DOCUMENTS) {
    return { valid: false, error: `Maximum ${MAX_DOCUMENTS} documents per message` };
  }

  if (fileType === 'image' && currentImageCount >= MAX_IMAGES) {
    return { valid: false, error: `Maximum ${MAX_IMAGES} images per message` };
  }

  return { valid: true };
}

export function formatAttachmentsForMessage(
  attachments: Pick<FileAttachment, 'name' | 'extractedText'>[],
): string {
  const withText = attachments.filter((a) => a.extractedText);
  if (withText.length === 0) {
    return '';
  }
  const lines = ['<attachments>'];
  for (const attachment of withText) {
    lines.push(`<file name="${attachment.name}">`);
    lines.push(attachment.extractedText!);
    lines.push('</file>');
  }
  lines.push('</attachments>');
  return lines.join('\n');
}

export function buildMultimodalContent(
  textContent: string,
  images: Pick<FileAttachment, 'base64Data' | 'base64MediaType'>[],
): string | ContentBlock[] {
  if (images.length === 0) {
    return textContent;
  }
  const blocks: ContentBlock[] = [];
  for (const image of images) {
    if (image.base64Data && image.base64MediaType) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.base64MediaType,
          data: image.base64Data,
        },
      });
    }
  }
  blocks.push({ type: 'text', text: textContent });
  return blocks;
}

export function encodeAttachmentMeta(meta: AttachmentMeta[]): string {
  const json = JSON.stringify(meta);
  const base64 = btoa(unescape(encodeURIComponent(json)));
  return `<span data-attachments="${base64}" hidden></span>`;
}

export function decodeAttachmentMeta(content: string): AttachmentMeta[] {
  const match = content.match(/<span data-attachments="([^"]+)" hidden><\/span>/);
  if (!match) {
    return [];
  }
  try {
    const json = decodeURIComponent(escape(atob(match[1])));
    return JSON.parse(json);
  } catch {
    return [];
  }
}

export function stripAttachmentMarkup(content: string): string {
  return content
    .replace(/<span data-attachments="[^"]*" hidden><\/span>\n?/, '')
    .replace(/<attachments>[\s\S]*?<\/attachments>\n*/g, '')
    .replace(/<image_attachment[^>]*>[\s\S]*?<\/image_attachment>\n*/g, '')
    .trim();
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

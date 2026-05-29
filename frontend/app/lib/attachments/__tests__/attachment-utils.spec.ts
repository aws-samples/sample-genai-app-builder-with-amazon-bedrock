import { describe, expect, it } from 'vitest';
import {
  validateFile,
  classifyFile,
  formatAttachmentsForMessage,
  buildMultimodalContent,
  encodeAttachmentMeta,
  decodeAttachmentMeta,
  stripAttachmentMarkup,
  formatFileSize,
} from '../attachment-utils';
import type { AttachmentMeta, FileAttachment } from '~/types/attachment';

describe('attachment-utils', () => {
  describe('validateFile', () => {
    it('should accept valid PDF', () => {
      const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      expect(validateFile(file, 0, 0)).toEqual({ valid: true });
    });

    it('should accept valid DOCX', () => {
      const file = new File(['content'], 'test.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      });
      expect(validateFile(file, 0, 0)).toEqual({ valid: true });
    });

    it('should accept valid Markdown', () => {
      const file = new File(['content'], 'test.md', { type: 'text/markdown' });
      expect(validateFile(file, 0, 0)).toEqual({ valid: true });
    });

    it('should accept valid image', () => {
      const file = new File(['content'], 'test.png', { type: 'image/png' });
      expect(validateFile(file, 0, 0)).toEqual({ valid: true });
    });

    it('should reject unsupported file type', () => {
      const file = new File(['content'], 'test.exe', { type: 'application/x-msdownload' });
      const result = validateFile(file, 0, 0);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('Unsupported file type');
    });

    it('should reject file over 10MB', () => {
      const bigContent = new ArrayBuffer(11 * 1024 * 1024);
      const file = new File([bigContent], 'big.pdf', { type: 'application/pdf' });
      const result = validateFile(file, 0, 0);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('10MB');
    });

    it('should reject when document count exceeds limit', () => {
      const file = new File(['content'], 'test.pdf', { type: 'application/pdf' });
      const result = validateFile(file, 5, 0);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('Maximum 5 documents');
    });

    it('should reject when image count exceeds limit', () => {
      const file = new File(['content'], 'test.png', { type: 'image/png' });
      const result = validateFile(file, 0, 5);
      expect(result.valid).toBe(false);
      if (!result.valid) expect(result.error).toContain('Maximum 5 images');
    });

    it('should accept .md files with text/plain MIME type', () => {
      const file = new File(['content'], 'notes.md', { type: 'text/plain' });
      expect(validateFile(file, 0, 0)).toEqual({ valid: true });
    });
  });

  describe('classifyFile', () => {
    it('should classify PDF as document', () => {
      const file = new File([''], 'test.pdf', { type: 'application/pdf' });
      expect(classifyFile(file)).toBe('document');
    });

    it('should classify PNG as image', () => {
      const file = new File([''], 'test.png', { type: 'image/png' });
      expect(classifyFile(file)).toBe('image');
    });

    it('should return null for unknown types', () => {
      const file = new File([''], 'test.exe', { type: 'application/x-msdownload' });
      expect(classifyFile(file)).toBeNull();
    });
  });

  describe('formatAttachmentsForMessage', () => {
    it('should format document attachments as XML', () => {
      const attachments: Pick<FileAttachment, 'name' | 'extractedText'>[] = [
        { name: 'notes.pdf', extractedText: 'Hello from PDF' },
        { name: 'draft.docx', extractedText: 'Hello from Word' },
      ];
      const result = formatAttachmentsForMessage(attachments);
      expect(result).toContain('<attachments>');
      expect(result).toContain('<file name="notes.pdf">');
      expect(result).toContain('Hello from PDF');
      expect(result).toContain('<file name="draft.docx">');
      expect(result).toContain('Hello from Word');
      expect(result).toContain('</attachments>');
    });

    it('should return empty string for no attachments', () => {
      expect(formatAttachmentsForMessage([])).toBe('');
    });
  });

  describe('buildMultimodalContent', () => {
    it('should return text-only content when no images', () => {
      const result = buildMultimodalContent('Hello', []);
      expect(result).toBe('Hello');
    });

    it('should return content array with images', () => {
      const images = [{ base64Data: 'abc123', base64MediaType: 'image/png' }];
      const result = buildMultimodalContent('Hello', images);
      expect(Array.isArray(result)).toBe(true);
      const blocks = result as any[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'abc123' },
      });
      expect(blocks[1]).toEqual({ type: 'text', text: 'Hello' });
    });

    it('should handle multiple images', () => {
      const images = [
        { base64Data: 'img1', base64MediaType: 'image/png' },
        { base64Data: 'img2', base64MediaType: 'image/jpeg' },
      ];
      const result = buildMultimodalContent('Hello', images);
      const blocks = result as any[];
      expect(blocks).toHaveLength(3);
    });
  });

  describe('encodeAttachmentMeta / decodeAttachmentMeta', () => {
    it('should round-trip attachment metadata', () => {
      const meta: AttachmentMeta[] = [
        { name: 'test.pdf', size: 1024, type: 'document', mimeType: 'application/pdf' },
        { name: 'photo.png', size: 2048, type: 'image', mimeType: 'image/png', thumbnailDataUrl: 'data:image/png;base64,abc' },
      ];
      const encoded = encodeAttachmentMeta(meta);
      expect(encoded).toContain('data-attachments=');
      const decoded = decodeAttachmentMeta(encoded + '\n\nHello world');
      expect(decoded).toEqual(meta);
    });

    it('should return empty array when no metadata present', () => {
      expect(decodeAttachmentMeta('Just a normal message')).toEqual([]);
    });
  });

  describe('stripAttachmentMarkup', () => {
    it('should strip metadata span and attachments XML', () => {
      const content = '<span data-attachments="eyJ0ZXN0IjoxfQ==" hidden></span>\n<attachments>\n<file name="test.pdf">\nHello\n</file>\n</attachments>\n\nUser message here';
      const result = stripAttachmentMarkup(content);
      expect(result).toBe('User message here');
    });

    it('should return content unchanged when no markup', () => {
      expect(stripAttachmentMarkup('Hello world')).toBe('Hello world');
    });

    it('should strip image attachment markers', () => {
      const content = '<image_attachment media_type="image/png">abc123base64data</image_attachment>\nUser message here';
      const result = stripAttachmentMarkup(content);
      expect(result).toBe('User message here');
    });
  });

  describe('formatFileSize', () => {
    it('should format bytes', () => {
      expect(formatFileSize(500)).toBe('500 B');
    });

    it('should format kilobytes', () => {
      expect(formatFileSize(1536)).toBe('1.5 KB');
    });

    it('should format megabytes', () => {
      expect(formatFileSize(2.5 * 1024 * 1024)).toBe('2.5 MB');
    });
  });
});

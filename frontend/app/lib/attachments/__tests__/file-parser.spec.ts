import { describe, expect, it } from 'vitest';
import { extractMarkdownText, readImageAsBase64 } from '../file-parser';

describe('file-parser', () => {
  describe('extractMarkdownText', () => {
    it('should extract text from a markdown file', async () => {
      const content = '# Hello\n\nThis is a test.';
      const file = new File([content], 'test.md', { type: 'text/markdown' });
      const result = await extractMarkdownText(file);
      expect(result).toBe('# Hello\n\nThis is a test.');
    });

    it('should handle empty markdown files', async () => {
      const file = new File([''], 'empty.md', { type: 'text/markdown' });
      const result = await extractMarkdownText(file);
      expect(result).toBe('');
    });
  });

  describe('readImageAsBase64', () => {
    it('should return base64 data and media type', async () => {
      const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      const file = new File([bytes], 'test.png', { type: 'image/png' });
      const result = await readImageAsBase64(file);
      expect(result.mediaType).toBe('image/png');
      expect(result.base64).toBeTruthy();
      expect(typeof result.base64).toBe('string');
    });

    it('should handle jpeg files', async () => {
      const bytes = new Uint8Array([0xff, 0xd8, 0xff]);
      const file = new File([bytes], 'photo.jpg', { type: 'image/jpeg' });
      const result = await readImageAsBase64(file);
      expect(result.mediaType).toBe('image/jpeg');
      expect(result.base64).toBeTruthy();
    });
  });
});

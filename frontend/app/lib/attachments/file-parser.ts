import type { FileAttachment } from '~/types/attachment';

export async function extractPdfText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    pages.push(pageText);
  }

  return pages.join('\n\n');
}

export async function extractDocxText(file: File): Promise<string> {
  const mammoth = await import('mammoth');
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

export async function extractMarkdownText(file: File): Promise<string> {
  return file.text();
}

export async function readImageAsBase64(file: File): Promise<{ base64: string; mediaType: string }> {
  const arrayBuffer = await file.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);

  // Use a portable base64 encoding approach that works in both browser and Node
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const base64 = btoa(binary);

  return { base64, mediaType: file.type };
}

export function generateThumbnail(file: File, maxSize: number = 80): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);

    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = document.createElement('canvas');
      const scale = Math.min(maxSize / img.width, maxSize / img.height, 1);
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');

      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Failed to load image for thumbnail'));
    };

    img.src = url;
  });
}

export async function processAttachment(
  attachment: FileAttachment,
  onUpdate: (updates: Partial<FileAttachment>) => void,
): Promise<void> {
  onUpdate({ status: 'processing' });
  try {
    if (attachment.type === 'document') {
      let extractedText: string;
      if (attachment.mimeType === 'application/pdf') {
        extractedText = await extractPdfText(attachment.file);
      } else if (
        attachment.mimeType ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      ) {
        extractedText = await extractDocxText(attachment.file);
      } else {
        extractedText = await extractMarkdownText(attachment.file);
      }
      onUpdate({ status: 'ready', extractedText });
    } else {
      const { base64, mediaType } = await readImageAsBase64(attachment.file);
      onUpdate({ status: 'ready', base64Data: base64, base64MediaType: mediaType });
    }
  } catch (error) {
    onUpdate({
      status: 'error',
      error: error instanceof Error ? error.message : 'Failed to process file',
    });
  }
}

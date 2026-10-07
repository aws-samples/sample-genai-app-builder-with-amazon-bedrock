import { S3Client, PutObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({});
const BUCKET = process.env.SHARED_SITES_BUCKET!;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
};

function getContentType(filename: string): string {
  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * The client collects the built site from the sandbox's `dist/` folder, so the
 * file paths arrive prefixed with `dist/`. The share is served from the share
 * root (`/shared/{id}/`), so that prefix has to be dropped when forming the S3
 * key — otherwise index.html lands at `shared/{id}/dist/index.html` and the
 * published link 403s. Any other single leading build-output folder is handled
 * the same way so the served tree always starts at the share root.
 */
function toSiteKey(shareId: string, file: string): string {
  const normalized = file.replace(/^\/+/, '').replace(/^(dist|build|out)\//, '');
  return `shared/${shareId}/${normalized}`;
}

export async function generateUploadUrls(
  shareId: string,
  files: string[],
): Promise<{ file: string; url: string; contentType: string }[]> {
  const urls = await Promise.all(
    files.map(async (file) => {
      const key = toSiteKey(shareId, file);
      const contentType = getContentType(file);
      const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
      const url = await getSignedUrl(s3, command, { expiresIn: 600 });

      // The client must send this same Content-Type on its PUT. A browser fetch
      // with a Uint8Array body sends none, and S3 then stores the object as
      // binary/octet-stream — which makes the shared page download instead of
      // render.
      return { file, url, contentType };
    }),
  );
  return urls;
}

export async function deleteShareFiles(s3Prefix: string): Promise<void> {
  const listResult = await s3.send(
    new ListObjectsV2Command({ Bucket: BUCKET, Prefix: s3Prefix }),
  );
  const objects = listResult.Contents?.map((obj) => ({ Key: obj.Key! }));
  if (!objects || objects.length === 0) return;

  await s3.send(
    new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: objects } }),
  );
}

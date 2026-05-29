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

export async function generateUploadUrls(shareId: string, files: string[]): Promise<{ file: string; url: string }[]> {
  const urls = await Promise.all(
    files.map(async (file) => {
      const key = `shared/${shareId}/${file}`;
      const contentType = getContentType(file);
      const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType });
      const url = await getSignedUrl(s3, command, { expiresIn: 600 });
      return { file, url };
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

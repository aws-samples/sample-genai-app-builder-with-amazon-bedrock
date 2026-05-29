import { memo, useCallback, useState } from 'react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { getRuntimePromise } from '~/lib/runtime';
import { getShareClient } from '~/lib/api/share-client';
import { createScopedLogger } from '~/utils/logger';
import type { RuntimeConnection, ShellExecResponse, FileSyncResponse } from '~/lib/runtime/types';

const logger = createScopedLogger('ShareButton');

type ShareState = 'idle' | 'building' | 'publishing' | 'done' | 'error';

export const ShareButton = memo(() => {
  const [state, setState] = useState<ShareState>('idle');
  const [shareUrl, setShareUrl] = useState<string | null>(null);

  const handleShare = useCallback(async () => {
    if (state === 'building' || state === 'publishing') {
      return;
    }

    setState('building');
    setShareUrl(null);

    let conn: RuntimeConnection;

    try {
      conn = await getRuntimePromise();
    } catch (err) {
      logger.error('Failed to get runtime connection:', err);
      toast.error('Sandbox not connected');
      setState('error');
      return;
    }

    try {
      // Step 1: Run npm run build in the sandbox
      logger.debug('Running npm run build...');
      const buildResult = await conn.request<ShellExecResponse>({
        type: 'shell:exec:req',
        payload: {
          command: 'npm run build',
          streamOutput: true,
          timeout: 120000,
        },
      });

      if (buildResult.payload.exitCode !== 0) {
        const stderr = buildResult.payload.stderr || '';
        throw new Error(`Build failed (exit code ${buildResult.payload.exitCode}): ${stderr}`);
      }

      logger.debug('Build completed successfully');

      // Step 2: Read the dist/ directory contents
      setState('publishing');

      const syncResult = await conn.request<FileSyncResponse>({
        type: 'fs:sync:req',
        payload: {
          include: ['dist/**'],
          exclude: [],
          includeContent: true,
        },
      });

      const distFiles = (syncResult.payload?.files || []).filter(
        (f) => f.type === 'file' && f.content,
      );

      if (distFiles.length === 0) {
        throw new Error('Build produced no output files in dist/');
      }

      const filePaths = distFiles.map((f) => f.path);
      logger.debug(`Found ${distFiles.length} files to upload`);

      // Step 3: Create share and get pre-signed upload URLs
      const shareClient = getShareClient();
      const shareResult = await shareClient.createShare('Shared Project', filePaths);

      // Step 4: Upload each file to its pre-signed URL
      const uploadPromises = shareResult.fileMap.map(async ({ file, url }) => {
        const distFile = distFiles.find((f) => f.path === file);

        if (!distFile || !distFile.content) {
          logger.warn(`No content found for file: ${file}`);
          return;
        }

        // Content from fs:sync comes base64-encoded for files
        let fileContent: Uint8Array;

        if (distFile.isBinary) {
          // Decode base64 to binary
          const binaryStr = atob(distFile.content);
          const bytes = new Uint8Array(binaryStr.length);

          for (let i = 0; i < binaryStr.length; i++) {
            bytes[i] = binaryStr.charCodeAt(i);
          }

          fileContent = bytes;
        } else {
          // Text content - try base64 decode first (sidecar sends base64)
          let text: string;

          try {
            text = atob(distFile.content);
          } catch {
            text = distFile.content;
          }

          fileContent = new TextEncoder().encode(text);
        }

        await shareClient.uploadFile(url, fileContent);
      });

      await Promise.all(uploadPromises);

      // Step 5: Confirm the share
      const confirmResult = await shareClient.confirmShare(shareResult.shareId, 'Shared Project');

      setShareUrl(confirmResult.url);
      setState('done');
      toast.success('Share link created!');
      logger.debug('Share published:', confirmResult.url);
    } catch (err) {
      logger.error('Share failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to share project');
      setState('error');
    }
  }, [state]);

  const handleCopyLink = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard.writeText(shareUrl).then(() => {
        toast.success('Link copied to clipboard!');
      }).catch(() => {
        // Fallback: select the URL text for manual copy
        toast.info('Could not copy automatically. URL: ' + shareUrl);
      });
    }
  }, [shareUrl]);

  const handleDismiss = useCallback(() => {
    setState('idle');
    setShareUrl(null);
  }, []);

  if (state === 'building') {
    return (
      <IconButton
        icon="i-ph:spinner"
        title="Building project..."
        disabled
        iconClassName="animate-spin"
      />
    );
  }

  if (state === 'publishing') {
    return (
      <IconButton
        icon="i-ph:spinner"
        title="Publishing..."
        disabled
        iconClassName="animate-spin"
      />
    );
  }

  if (state === 'done' && shareUrl) {
    return (
      <div className="flex items-center gap-1">
        <IconButton
          icon="i-ph:copy"
          title="Copy share link"
          onClick={handleCopyLink}
        />
        <IconButton
          icon="i-ph:x"
          title="Dismiss"
          size="sm"
          onClick={handleDismiss}
        />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex items-center gap-1">
        <IconButton
          icon="i-ph:share-network"
          title="Retry share"
          onClick={handleShare}
        />
        <IconButton
          icon="i-ph:x"
          title="Dismiss"
          size="sm"
          onClick={handleDismiss}
        />
      </div>
    );
  }

  // idle state
  return (
    <IconButton
      icon="i-ph:share-network"
      title="Share project"
      onClick={handleShare}
    />
  );
});

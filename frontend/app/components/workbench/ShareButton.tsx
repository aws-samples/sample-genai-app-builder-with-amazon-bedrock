import { memo, useCallback, useState } from 'react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { getConnection } from '~/lib/runtime';
import { getShareClient } from '~/lib/api/share-client';
import { publishShare, type DistFile } from '~/lib/share/share-flow';
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
      conn = await getConnection();
    } catch (err) {
      logger.error('Failed to get runtime connection:', err);
      toast.error('Sandbox not connected');
      setState('error');

      return;
    }

    try {
      const shareClient = getShareClient();

      const url = await publishShare({
        runBuild: async (command) => {
          logger.debug(`Running ${command}...`);

          const buildResult = await conn.request<ShellExecResponse>({
            type: 'shell:exec:req',
            payload: { command, streamOutput: true, timeout: 120000 },
          });

          return {
            exitCode: buildResult.payload.exitCode,
            stderr: buildResult.payload.stderr,
          };
        },
        collectDist: async (): Promise<DistFile[]> => {
          const syncResult = await conn.request<FileSyncResponse>({
            type: 'fs:sync:req',
            payload: { include: ['dist/**'], exclude: [], includeContent: true },
          });

          return (syncResult.payload?.files || [])
            .filter((f) => f.type === 'file' && f.content)
            .map((f) => ({ path: f.path, content: f.content!, isBinary: f.isBinary }));
        },
        createShare: (title, files) => shareClient.createShare(title, files),
        uploadFile: (url, content, contentType) => shareClient.uploadFile(url, content, contentType),
        confirmShare: (shareId, title) => shareClient.confirmShare(shareId, title),
        onProgress: () => setState('publishing'),
      });

      setShareUrl(url);
      setState('done');
      toast.success('Share link created!');
      logger.debug('Share published:', url);
    } catch (err) {
      logger.error('Share failed:', err);

      /**
       * Keep the failure on screen until dismissed. A share can fail late (after
       * a long build) on an upload the user never sees, so an auto-closing toast
       * let it look like nothing happened — the whole point of this report.
       */
      toast.error(err instanceof Error ? err.message : 'Failed to share project', {
        toastId: 'share-failure',
        autoClose: false,
      });
      setState('error');
    }
  }, [state]);

  const handleCopyLink = useCallback(() => {
    if (shareUrl) {
      navigator.clipboard
        .writeText(shareUrl)
        .then(() => {
          toast.success('Link copied to clipboard!');
        })
        .catch(() => {
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
    return <IconButton icon="i-ph:spinner" title="Building project..." disabled iconClassName="animate-spin" />;
  }

  if (state === 'publishing') {
    return <IconButton icon="i-ph:spinner" title="Publishing..." disabled iconClassName="animate-spin" />;
  }

  if (state === 'done' && shareUrl) {
    return (
      <div className="flex items-center gap-1">
        <IconButton icon="i-ph:copy" title="Copy share link" onClick={handleCopyLink} />
        <IconButton icon="i-ph:x" title="Dismiss" size="sm" onClick={handleDismiss} />
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div className="flex items-center gap-1">
        <IconButton icon="i-ph:share-network" title="Retry share" onClick={handleShare} />
        <IconButton icon="i-ph:x" title="Dismiss" size="sm" onClick={handleDismiss} />
      </div>
    );
  }

  // idle state
  return <IconButton icon="i-ph:share-network" title="Share project" onClick={handleShare} />;
});

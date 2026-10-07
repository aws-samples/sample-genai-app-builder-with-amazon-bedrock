import { useEffect, useState } from 'react';
import { Link } from '@remix-run/react';
import type { ExtractionProgress as Progress } from '~/types/brandTemplate';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';
import { removePendingJob } from '~/lib/brand-templates/pending-jobs';

interface ExtractionProgressProps {
  jobId: string;
  onReady: (skillId: string) => void;
}

export function ExtractionProgress({ jobId, onReady }: ExtractionProgressProps) {
  const [progress, setProgress] = useState<Progress | undefined>();
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const client = getBrandTemplatesClient();

    (async () => {
      try {
        const result = await client.pollUntilDone(jobId, {
          intervalMs: 3000,
          signal: controller.signal,
          onProgress: (p) => setProgress(p),
        });
        // Drop the persisted record so PendingExtractionsWatcher doesn't
        // re-toast a job the user is already looking at.
        await removePendingJob(jobId);
        onReady(result.skillId);
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
        await removePendingJob(jobId);
        setFailure(err instanceof Error ? err.message : 'Extraction failed.');
      }
    })();

    return () => controller.abort();
  }, [jobId, onReady]);

  if (failure) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-3 rounded-lg border border-red-500/40 bg-red-500/10 p-6">
        <h2 className="text-base font-medium text-red-400">Extraction failed</h2>
        <p className="text-sm text-vibe-elements-textSecondary">{failure}</p>
        {/*
         * Use an anchor (<Link>) rather than a navigate() button so the
         * control has native "go to URL" semantics: right-click menu,
         * open-in-new-tab, and no dependency on a click handler firing
         * after any outer wrapper interferes with pointer events.
         */}
        <Link
          to="/brand-templates"
          className="self-start rounded-md bg-vibe-elements-button-secondary-background px-3 py-1.5 text-sm text-vibe-elements-button-secondary-text hover:bg-vibe-elements-button-secondary-backgroundHover"
        >
          Back to skills
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col items-center gap-4 rounded-lg border border-vibe-elements-borderColor bg-vibe-elements-background-depth-2 p-8 text-center">
      <div className="i-svg-spinners:90-ring-with-bg text-3xl text-vibe-elements-loader-progress" />
      <h2 className="text-base font-medium text-vibe-elements-textPrimary">
        Extracting your brand template
      </h2>
      <p className="min-h-[20px] text-sm text-vibe-elements-textSecondary">
        {progress?.message ?? 'Starting…'}
      </p>
      {typeof progress?.percent === 'number' && (
        <div className="h-1 w-full overflow-hidden rounded bg-vibe-elements-background-depth-3">
          <div
            className="h-full bg-vibe-elements-loader-progress transition-all"
            style={{ width: `${progress.percent}%` }}
          />
        </div>
      )}
    </div>
  );
}

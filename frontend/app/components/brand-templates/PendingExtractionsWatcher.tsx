import { useEffect, useRef } from 'react';
import { toast } from 'react-toastify';
import { Link } from '@remix-run/react';
import { getBrandTemplatesClient } from '~/lib/brand-templates/client';
import {
  listPendingJobs,
  removePendingJob,
  type PendingJob,
} from '~/lib/brand-templates/pending-jobs';

/**
 * Background watcher for brand-template extractions started in a previous
 * session (or the user navigated away while one was running). On mount it
 * reads `pending-jobs` from IndexedDB and polls each one, toasting when a
 * skill becomes ready or fails.
 *
 * Coexistence with <ExtractionProgress>: when both are mounted for the
 * same job, both poll the same DDB record. The first one to observe a
 * terminal state removes the row from `pending-jobs`; the watcher's next
 * tick won't see the job and won't double-toast. A small race window is
 * possible but `dispatched.current` keeps the toast unique per session.
 */
export function PendingExtractionsWatcher() {
  // Tracks jobIds we've already toasted in this session, so a flapping
  // status check (or a redundant in-route + watcher completion) doesn't
  // produce duplicate toasts in the same browser tab.
  const dispatched = useRef<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function watchJob(job: PendingJob) {
      if (dispatched.current.has(job.jobId)) return;
      try {
        const result = await getBrandTemplatesClient().pollUntilDone(job.jobId, {
          intervalMs: 5000,
          // Slightly longer than the in-route progress page; if the user
          // closed the tab and reopens it days later the job is long gone
          // anyway, but we don't want to time out a long-running extraction
          // just because they're checking a different page.
          timeoutMs: 15 * 60 * 1000,
          signal: controller.signal,
        });
        if (cancelled || dispatched.current.has(job.jobId)) return;
        dispatched.current.add(job.jobId);
        await removePendingJob(job.jobId);
        toast.success(
          (props) => (
            <div className="flex flex-col gap-1">
              <span>Brand template ready: {job.name}</span>
              <Link
                to={`/brand-templates/${result.skillId}`}
                className="text-xs underline"
                onClick={() => props.closeToast?.()}
              >
                View
              </Link>
            </div>
          ),
          { autoClose: 8000 },
        );
      } catch (err) {
        if (cancelled || (err as DOMException)?.name === 'AbortError') return;
        if (dispatched.current.has(job.jobId)) return;
        dispatched.current.add(job.jobId);
        await removePendingJob(job.jobId);
        const msg = err instanceof Error ? err.message : 'Extraction failed.';
        toast.error(`Brand template failed: ${job.name} — ${msg}`, {
          autoClose: 10000,
        });
      }
    }

    (async () => {
      const jobs = await listPendingJobs();
      if (cancelled) return;
      // Fire all polls in parallel; pollUntilDone manages its own backoff.
      jobs.forEach((job) => void watchJob(job));
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return null;
}

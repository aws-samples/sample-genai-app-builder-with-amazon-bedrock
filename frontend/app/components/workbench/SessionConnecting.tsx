import { useStore } from '@nanostores/react';
import { memo } from 'react';
import { LoadingDots } from '~/components/ui/LoadingDots';
import { getConnection, resetRuntimePromise } from '~/lib/runtime';
import {
  isJoiningSharedSession,
  sessionStatus,
  sessionStatusDetail,
  setSessionStatus,
} from '~/lib/runtime/session-status';

/**
 * Overlay shown over the workbench while the sandbox session is still coming up.
 *
 * A collaborator who follows an invite link opens straight into the workbench,
 * but the file tree and editor stay empty for the few seconds it takes to redeem
 * the invite, connect the WebSocket and receive the first file sync. Without this
 * that gap reads as a broken, blank page. Rendered only for the joining case so a
 * normal solo session — which streams files in as the AI writes them — is
 * unaffected.
 */
export const SessionConnecting = memo(() => {
  const status = useStore(sessionStatus);
  const detail = useStore(sessionStatusDetail);

  /**
   * Only guests joining a shared session get the overlay; a solo builder's empty
   * workbench before their first prompt is expected, not "connecting".
   */
  if (!isJoiningSharedSession()) {
    return null;
  }

  if (status === 'ready' || status === 'idle') {
    return null;
  }

  const failed = status === 'failed';

  return (
    <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-vibe-elements-background-depth-2 backdrop-blur-sm">
      {failed ? (
        <>
          <div className="i-ph:plugs text-4xl text-vibe-elements-textSecondary" />
          <p className="text-vibe-elements-textSecondary text-center max-w-xs">
            {detail ?? 'Could not join the shared session.'}
          </p>
          <button
            className="px-3 py-1.5 rounded-md text-sm bg-vibe-elements-button-primary-background text-vibe-elements-button-primary-text hover:bg-vibe-elements-button-primary-backgroundHover"
            onClick={() => {
              /**
               * Drop the failed connection and boot again from a warmer state
               * (auth is hydrated by now, the usual cause of a first-try miss).
               * Reset first so a resolved-but-dead connection is discarded too,
               * then getConnection re-boots and every store recovers with it.
               */
              resetRuntimePromise();
              setSessionStatus('connecting');
              void getConnection();
            }}
          >
            Try again
          </button>
        </>
      ) : (
        <>
          <div className="i-svg-spinners:90-ring-with-bg text-3xl text-vibe-elements-loader-progress" />
          <LoadingDots text={status === 'syncing' ? 'Loading shared files' : 'Connecting to shared session'} />
        </>
      )}
    </div>
  );
});

import { useStore } from '@nanostores/react';
import { memo, useCallback, useEffect, useState } from 'react';
import { toast } from 'react-toastify';
import { IconButton } from '~/components/ui/IconButton';
import { PanelHeaderButton } from '~/components/ui/PanelHeaderButton';
import { collabStore, type CollabPeer } from '~/lib/collab/collab-store';
import { getSessionClient } from '~/lib/api/session-client';
import { chatId } from '~/lib/persistence';
import { classNames } from '~/utils/classNames';
import { createScopedLogger } from '~/utils/logger';
import { mintInviteToken } from '~/lib/collab/invite-flow';
import { getConnection } from '~/lib/runtime';

const logger = createScopedLogger('LiveShareButton');

/**
 * "Go live" control for real-time co-editing plus a live presence roster.
 *
 * Toggling on calls {@link collabStore.enableCollab}, which lazily creates the
 * Yjs provider over the session's sidecar relay; toggling off tears it down and
 * returns to solo editing. When live, we render a small stack of collaborator
 * avatars (initials on their cursor colour) and a "synced" dot once the shared
 * document has converged with at least one peer.
 */
export const LiveShareButton = memo(() => {
  const provider = useStore(collabStore.provider);
  const synced = useStore(collabStore.synced);
  const peers = useStore(collabStore.peers);

  const [busy, setBusy] = useState(false);
  const [inviting, setInviting] = useState(false);
  const isLive = provider !== null;

  const toggle = useCallback(async () => {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      if (collabStore.isEnabled()) {
        collabStore.disableCollab();
      } else {
        await collabStore.enableCollab();
        if (!collabStore.isEnabled()) {
          toast.error('Could not start live session — sandbox not connected');
        }
      }
    } finally {
      setBusy(false);
    }
  }, [busy]);

  /**
   * Someone who arrived on an invite link is already in the owner's session, so
   * go live immediately — asking them to press "Go live" before they can see
   * anyone would just look broken.
   */
  useEffect(() => {
    if (typeof window === 'undefined' || !(window as any).__SANDBOX_JOINED_SESSION__) {
      return;
    }
    if (collabStore.isEnabled()) {
      return;
    }
    void collabStore.enableCollab();
  }, []);

  /**
   * Mint an invite link and put it on the clipboard. Going live first means the
   * inviter is already present when their guest arrives, so the guest sees a
   * populated session rather than an empty one.
   */
  const invite = useCallback(async () => {
    if (inviting) {
      return;
    }
    setInviting(true);
    try {
      // Going live happens in the background rather than ahead of the link. It
      // used to be awaited here, and since it awaits the sandbox boot that meant
      // a cold project sat for 30-70s after the click while the invite endpoint
      // itself answers in ~250ms. See `invite-flow.ts`.
      const token = await mintInviteToken({
        isCollabEnabled: () => collabStore.isEnabled(),
        enableCollab: () => collabStore.enableCollab(),
        getSessionId: () => (window as any).__SANDBOX_SESSION_ID__ as string | undefined,
        ensureConnected: async () => {
          await getConnection();
        },
        // Pass the project so the invite grants its conversation as well as the
        // sandbox — otherwise the guest gets the files with no history behind them.
        createInvite: (sessionId) => getSessionClient().createInvite(sessionId, chatId.get()),
        onBackgroundError: (error) => logger.error('Going live after the invite failed:', error),
      });

      const url = new URL(window.location.href);
      url.searchParams.set('join', token);
      const link = url.toString();

      try {
        await navigator.clipboard.writeText(link);
        // Matches INVITE_TTL_SECONDS in the session manager, which enforces it.
        toast.success('Invite link copied — it works once and expires in 3 days');
      } catch {
        // Clipboard access can be denied; the link is useless if we swallow it.
        toast.info(`Invite link (works once, expires in 3 days): ${link}`, { autoClose: false });
      }
    } catch (err) {
      logger.error('Failed to create invite:', err);
      toast.error('Could not create an invite link');
    } finally {
      setInviting(false);
    }
  }, [inviting]);

  if (busy) {
    return <IconButton icon="i-ph:spinner" title="Connecting live session…" disabled iconClassName="animate-spin" />;
  }

  if (!isLive) {
    return (
      <>
        <PanelHeaderButton className="mr-1 text-sm" onClick={toggle}>
          <div className="i-ph:broadcast" />
          Go live
        </PanelHeaderButton>
        <InviteButton onClick={invite} busy={inviting} />
      </>
    );
  }

  return (
    <div className="flex items-center gap-1.5 mr-1" data-testid="live-presence">
      <PresenceStack peers={peers} />
      <span
        className={classNames('inline-block w-2 h-2 rounded-full', {
          'bg-green-500': synced,
          'bg-yellow-400 animate-pulse': !synced,
        })}
        title={synced ? 'Synced with collaborators' : 'Connecting…'}
        data-testid={synced ? 'collab-synced' : 'collab-connecting'}
      />
      <InviteButton onClick={invite} busy={inviting} />
      <IconButton icon="i-ph:broadcast-fill" title="Stop live session" onClick={toggle} iconClassName="text-green-500" />
    </div>
  );
});

const InviteButton = memo(({ onClick, busy }: { onClick: () => void; busy: boolean }) => {
  if (busy) {
    return <IconButton icon="i-ph:spinner" title="Creating invite link…" disabled iconClassName="animate-spin" />;
  }

  return (
    <PanelHeaderButton className="mr-1 text-sm" onClick={onClick} data-testid="invite-button">
      <div className="i-ph:user-plus" />
      Invite
    </PanelHeaderButton>
  );
});

const PresenceStack = memo(({ peers }: { peers: CollabPeer[] }) => {
  if (peers.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center -space-x-1.5" data-testid="presence-avatars">
      {peers.map((peer) => (
        <div
          key={peer.clientId}
          className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-semibold text-white ring-2 ring-vibe-elements-background-depth-2"
          style={{ backgroundColor: peer.color }}
          title={peer.isLocal ? `${peer.name} (you)` : peer.name}
          data-testid="presence-avatar"
        >
          {initials(peer.name)}
        </div>
      ))}
    </div>
  );
});

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {
    return '?';
  }
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

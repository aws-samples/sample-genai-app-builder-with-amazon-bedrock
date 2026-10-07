import { atom } from 'nanostores';
import * as Y from 'yjs';
import { getConnection } from '~/lib/runtime';
import { createScopedLogger } from '~/utils/logger';
import { CollabProvider } from './collab-provider';
import { RuntimeCollabTransport } from './collab-transport';
import { startCollabAutosave } from './collab-autosave';
import { makeCollabUser, type CollabUser } from './collab-user';

const logger = createScopedLogger('CollabStore');

/** A collaborator present in the session, as shown in the presence UI. */
export interface CollabPeer extends CollabUser {
  /** Yjs client id — stable for the lifetime of a peer's connection. */
  clientId: number;
  /** True for the local user (this browser). */
  isLocal: boolean;
}

/**
 * Derive the presence roster from a raw Awareness state map, tagging the local
 * client. Peers without a resolved `user` field are given a neutral fallback so
 * a mid-handshake client still renders rather than disappearing. Pure and
 * transport-free so it can be unit-tested against a plain Awareness snapshot.
 */
export function derivePeers(
  states: Map<number, { user?: Partial<CollabUser> }>,
  localClientId: number,
): CollabPeer[] {
  const peers: CollabPeer[] = [];
  for (const [clientId, state] of states) {
    const user = state?.user ?? {};
    peers.push({
      clientId,
      name: user.name ?? 'Anonymous',
      color: user.color ?? '#9ac2c9',
      isLocal: clientId === localClientId,
    });
  }
  // Local user first, then remote peers in stable client-id order.
  return peers.sort((a, b) => (a.isLocal === b.isLocal ? a.clientId - b.clientId : a.isLocal ? -1 : 1));
}

function readPeers(provider: CollabProvider): CollabPeer[] {
  return derivePeers(provider.awareness.getStates(), provider.doc.clientID);
}

/**
 * Owns the single {@link CollabProvider} for the current session. The provider
 * is created lazily and only when collaboration is enabled, so the solo
 * editing path pays nothing: no `Y.Doc`, no transport, no awareness.
 *
 * Enablement is opt-in via {@link enableCollab} (called when a project is
 * opened as a shared/multiplayer session). Until then `provider` stays null
 * and the editor renders exactly as before.
 */
class CollabStore {
  /** The active provider, or null when collaboration is off. */
  readonly provider = atom<CollabProvider | null>(null);
  /** Whether the shared doc has converged with at least one peer. */
  readonly synced = atom<boolean>(false);
  /** Live roster of collaborators (local + remote) for the presence UI. */
  readonly peers = atom<CollabPeer[]>([]);

  #booting = false;
  #unsubSynced: (() => void) | null = null;
  #stopAutosave: (() => void) | null = null;
  #onAwareness: (() => void) | null = null;
  #awarenessTarget: CollabProvider['awareness'] | null = null;

  /**
   * Turn on collaboration for this session. Idempotent: repeated calls while a
   * provider exists (or is booting) are no-ops.
   */
  async enableCollab(identity: { displayName?: string; id?: string } = {}): Promise<void> {
    if (this.provider.get() || this.#booting) {
      return;
    }
    this.#booting = true;

    try {
      const connection = await getConnection();
      const doc = new Y.Doc();
      const transport = new RuntimeCollabTransport(connection);
      const provider = new CollabProvider(doc, transport);

      provider.awareness.setLocalStateField('user', makeCollabUser(identity));

      this.#unsubSynced = provider.onSynced((s) => this.synced.set(s));

      // Mirror the awareness roster into a nanostore so React presence UI can
      // subscribe without touching Yjs internals.
      const refreshPeers = () => this.peers.set(readPeers(provider));
      provider.awareness.on('change', refreshPeers);
      this.#onAwareness = refreshPeers;
      this.#awarenessTarget = provider.awareness;
      refreshPeers();

      // Make co-edits durable. Without this a collaborator's typing is visible to
      // both peers and never reaches the container, so the dev server does not
      // rebuild and the next reload re-seeds the doc from disk and loses it.
      //
      // Imported here rather than at module scope so the solo editing path — which
      // never calls this — does not pull the workbench store into the collab module
      // graph.
      const { workbenchStore } = await import('~/lib/stores/workbench');

      this.#stopAutosave = startCollabAutosave(doc, {
        diskContent: (filePath) => workbenchStore.diskContent(filePath),
        save: (filePath, content) => workbenchStore.saveFileContent(filePath, content),
      });

      this.provider.set(provider);
      logger.info('Collaboration enabled for session');
    } catch (err) {
      logger.error('Failed to enable collaboration:', err);
    } finally {
      this.#booting = false;
    }
  }

  /** Tear down collaboration and return to solo editing. */
  disableCollab(): void {
    const provider = this.provider.get();
    if (!provider) {
      return;
    }
    this.#unsubSynced?.();
    this.#unsubSynced = null;
    this.#stopAutosave?.();
    this.#stopAutosave = null;
    if (this.#awarenessTarget && this.#onAwareness) {
      this.#awarenessTarget.off('change', this.#onAwareness);
    }
    this.#onAwareness = null;
    this.#awarenessTarget = null;
    provider.destroy();
    this.provider.set(null);
    this.synced.set(false);
    this.peers.set([]);
    logger.info('Collaboration disabled');
  }

  isEnabled(): boolean {
    return this.provider.get() !== null;
  }
}

export const collabStore = new CollabStore();

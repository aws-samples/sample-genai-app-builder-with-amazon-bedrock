import { atom } from 'nanostores';

/**
 * Lifecycle of the sandbox session connection, surfaced to the UI so a joining
 * collaborator sees "connecting…" instead of a blank workbench while the async
 * boot (wait-for-identity → join → WebSocket → first file sync) is in flight.
 *
 * - `idle`       nothing started yet
 * - `connecting` boot is running (session create/join, WebSocket handshake)
 * - `syncing`    connected; waiting for the first files to arrive from the container
 * - `ready`      files are present — the workbench is usable
 * - `failed`     boot gave up; the UI should offer a retry
 */
export type SessionStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'failed';

/**
 * True when this browser followed an invite link, read synchronously so the
 * workbench can show a "connecting to shared session" state on the very first
 * render — before any async boot has had a chance to run. Kept here (not in the
 * runtime module) so importing it never pulls in the runtime boot code.
 */
export function isJoiningSharedSession(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  /**
   * The runtime sets this once it has decided; before that, fall back to the
   * URL so the first paint is already correct for a guest on an invite link.
   */
  if ((window as any).__SANDBOX_JOINED_SESSION__ !== undefined) {
    return Boolean((window as any).__SANDBOX_JOINED_SESSION__);
  }

  return new URLSearchParams(window.location.search).get('join') !== null;
}

/**
 * Current connection status. A guest on an invite link starts in `connecting`
 * so the first render already shows progress rather than an empty panel.
 */
export const sessionStatus = atom<SessionStatus>(isJoiningSharedSession() ? 'connecting' : 'idle');

/** A human-readable reason for the most recent `failed` transition, if any. */
export const sessionStatusDetail = atom<string | undefined>(undefined);

export function setSessionStatus(status: SessionStatus, detail?: string): void {
  sessionStatus.set(status);
  sessionStatusDetail.set(detail);
}

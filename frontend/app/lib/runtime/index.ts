/**
 * Runtime abstraction layer.
 *
 * Uses the ECS Fargate container runtime via WebSocket connection
 * to the sidecar agent.
 */

export type { RuntimeConnection } from './types';

import type { RuntimeConnection } from './types';

/**
 * The in-flight or established connection, shared so every consumer (file store,
 * terminal, previews, action runner) talks to one sandbox instead of booting
 * several.
 */
let runtimePromise: Promise<RuntimeConnection> | null = null;

/**
 * Get the runtime connection promise.
 *
 * A failed boot is deliberately NOT cached. Caching a rejection left every later
 * file write, command and terminal attempt failing against a connection that was
 * never established — visible as a project whose actions all fail at once, an
 * empty file tree, and no way back except a manual reload.
 *
 * That mattered because the first attempt races page load: creating a sandbox
 * session needs an authenticated identity, and auth may not have hydrated yet.
 * Clearing the slot on failure means the next caller retries with warmer state.
 *
 * Prefer {@link getConnection} for per-operation use.
 */
export function getRuntimePromise(): Promise<RuntimeConnection> {
  if (runtimePromise) {
    return runtimePromise;
  }

  runtimePromise = import('./container-runtime')
    .then((mod) => mod.bootContainerRuntime())
    .catch((error) => {
      runtimePromise = null;
      throw error;
    });

  return runtimePromise;
}

/**
 * Resolve the runtime connection, re-booting only when the last boot failed.
 *
 * This is the accessor every consumer should await per operation, rather than
 * capturing the boot promise once. Capturing once is what made the workbench so
 * flaky: the stores took a single promise at construction time — before auth had
 * hydrated — and if that first boot rejected, they held the rejected promise for
 * the life of the page. A settled promise never re-runs, so every file write and
 * command afterwards awaited a connection that was never established (the column
 * of red crosses over an empty file tree), recoverable only by a full reload.
 * `getRuntimePromise` fixes that by clearing its slot on rejection, so awaiting
 * it here gives the next caller a fresh attempt.
 *
 * It deliberately does NOT tear down a connection that is merely mid-reconnect.
 * `RuntimeConnectionImpl` already reconnects itself (see `reconnect` in its
 * config), and its `connect()` only resolves once the container re-emits
 * `system:ready`. Forcing a fresh boot because `isConnected()` momentarily read
 * false raced that recovery: it discarded a socket that was about to come back
 * and started a second connection to a session already pinned to the first,
 * whose `system:ready` never arrived — so the boot promise hung forever and
 * "Go live" stuck on "Connecting live session…". Let the connection self-heal;
 * only a rejected boot warrants a new one.
 */
export async function getConnection(): Promise<RuntimeConnection> {
  return getRuntimePromise();
}

/**
 * Drop the cached connection so the next call boots a fresh one.
 *
 * For an explicit reconnect: the promise resolved, so the retry above does not
 * apply, but the connection underneath it may since have died.
 */
export function resetRuntimePromise(): void {
  runtimePromise = null;
}

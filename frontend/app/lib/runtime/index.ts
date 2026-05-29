/**
 * Runtime abstraction layer.
 *
 * Uses the ECS Fargate container runtime via WebSocket connection
 * to the sidecar agent.
 */

export type { RuntimeConnection } from './types';

/**
 * Get the runtime connection promise.
 * Connects to sidecar via WebSocket.
 */
export function getRuntimePromise() {
  return import('./container-runtime').then((mod) => mod.bootContainerRuntime());
}

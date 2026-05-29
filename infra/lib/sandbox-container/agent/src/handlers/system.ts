import { randomUUID } from 'node:crypto';
import {
  createResponse,
  createEvent,
  type WSMessage,
  type WSResponse,
  type WSEvent,
} from '../protocol.js';

const WORKDIR = process.env.WORKDIR ?? '/home/sandbox/project';
const startTime = Date.now();

/**
 * Handle system:ping:req – return server uptime.
 */
export function handlePing(msg: WSMessage): WSResponse {
  return createResponse(msg.id, 'system:ping:res', {
    uptime: Date.now() - startTime,
  });
}

/**
 * Create a system:ready:event to send on new connection.
 */
export function createReadyEvent(sessionId?: string): WSEvent {
  return createEvent('system:ready:event', {
    sessionId: sessionId ?? randomUUID(),
    containerId: process.env.HOSTNAME ?? 'unknown',
    workdir: WORKDIR,
  });
}

/**
 * Create a system:error:event for sending error notifications.
 */
export function createErrorEvent(code: string, message: string): WSEvent {
  return createEvent('system:error:event', { code, message });
}

/**
 * Route a system:* message to the correct handler.
 */
export function handleSystem(msg: WSMessage): WSResponse {
  const action = msg.type.split(':')[1];

  switch (action) {
    case 'ping':
      return handlePing(msg);
    default:
      throw new Error(`Unknown system action: ${action}`);
  }
}

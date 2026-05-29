import { randomUUID } from 'node:crypto';

// ── Base message types ──────────────────────────────────────────────

export interface WSMessage {
  id: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}

export interface WSResponse extends WSMessage {
  requestId: string;
}

export interface WSEvent extends WSMessage {}

// ── Direction suffixes ──────────────────────────────────────────────

export type Direction = 'req' | 'res' | 'event';

// ── Filesystem payload types ────────────────────────────────────────

export interface FsWritePayload {
  path: string;
  content: string;
  encoding?: BufferEncoding;
}

export interface FsReadPayload {
  path: string;
  encoding?: BufferEncoding;
}

export interface FsReadResponsePayload {
  content: string;
  isBinary: boolean;
  encoding: string;
}

export interface FsMkdirPayload {
  path: string;
}

export interface FsSyncPayload {
  include?: string[];
  exclude?: string[];
  includeContent?: boolean;
}

export interface FsSyncFile {
  path: string;
  type: 'file' | 'directory';
  content?: string;
  isBinary?: boolean;
}

export interface FsSyncResponsePayload {
  files: FsSyncFile[];
}

export interface FsChangeEventPayload {
  eventType: 'add_file' | 'change' | 'remove_file' | 'add_dir' | 'remove_dir';
  path: string;
  content?: string;
  isBinary?: boolean;
}

// ── Terminal payload types ──────────────────────────────────────────

export interface TerminalCreatePayload {
  cols?: number;
  rows?: number;
  shell?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface TerminalCreateResponsePayload {
  terminalId: string;
}

export interface TerminalInputPayload {
  terminalId: string;
  data: string; // base64
}

export interface TerminalResizePayload {
  terminalId: string;
  cols: number;
  rows: number;
}

export interface TerminalClosePayload {
  terminalId: string;
}

export interface TerminalOutputEventPayload {
  terminalId: string;
  data: string; // base64
}

export interface TerminalExitEventPayload {
  terminalId: string;
  exitCode: number;
}

// ── Shell payload types ─────────────────────────────────────────────

export interface ShellExecPayload {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ShellExecResponsePayload {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  processId: number;
}

export interface ShellKillPayload {
  processId: number;
}

export interface ShellOutputEventPayload {
  processId: number;
  stream: 'stdout' | 'stderr';
  data: string;
}

// ── Port payload types ──────────────────────────────────────────────

export interface PortOpenEventPayload {
  port: number;
  url: string;
  protocol: string;
}

export interface PortCloseEventPayload {
  port: number;
}

export interface PortListResponsePayload {
  ports: Array<{ port: number; pid?: number }>;
}

// ── System payload types ────────────────────────────────────────────

export interface SystemReadyEventPayload {
  sessionId: string;
  containerId: string;
  workdir: string;
}

export interface SystemPingResponsePayload {
  uptime: number;
}

export interface SystemErrorEventPayload {
  code: string;
  message: string;
}

// ── Namespace type ──────────────────────────────────────────────────

export type Namespace = 'fs' | 'terminal' | 'shell' | 'port' | 'system';

// ── Helper functions ────────────────────────────────────────────────

/**
 * Extract the namespace from a message type string.
 * e.g. "fs:write:req" → "fs"
 */
export function getNamespace(type: string): Namespace | null {
  const parts = type.split(':');
  if (parts.length < 3) return null;
  const ns = parts[0];
  if (['fs', 'terminal', 'shell', 'port', 'system'].includes(ns)) {
    return ns as Namespace;
  }
  return null;
}

/**
 * Extract the direction suffix from a message type.
 * e.g. "fs:write:req" → "req"
 */
export function getDirection(type: string): Direction | null {
  const parts = type.split(':');
  const last = parts[parts.length - 1];
  if (last === 'req' || last === 'res' || last === 'event') {
    return last;
  }
  return null;
}

/**
 * Create a response message linked to a request.
 */
export function createResponse(
  requestId: string,
  type: string,
  payload: Record<string, unknown>
): WSResponse {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    requestId,
    payload,
  };
}

/**
 * Create an event message (no request linkage).
 */
export function createEvent(
  type: string,
  payload: Record<string, unknown>
): WSEvent {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

/**
 * Parse a raw WebSocket string into a WSMessage.
 * Throws if the message is malformed.
 */
export function parseMessage(raw: string): WSMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON message');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Message must be a JSON object');
  }

  const msg = parsed as Record<string, unknown>;

  if (typeof msg.id !== 'string' || msg.id.length === 0) {
    throw new Error('Message must have a non-empty string "id"');
  }

  if (typeof msg.type !== 'string' || msg.type.length === 0) {
    throw new Error('Message must have a non-empty string "type"');
  }

  if (typeof msg.timestamp !== 'number') {
    throw new Error('Message must have a numeric "timestamp"');
  }

  if (typeof msg.payload !== 'object' || msg.payload === null) {
    throw new Error('Message must have an object "payload"');
  }

  return {
    id: msg.id as string,
    type: msg.type as string,
    timestamp: msg.timestamp as number,
    payload: msg.payload as Record<string, unknown>,
  };
}

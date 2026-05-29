/**
 * WebSocket protocol types for the sandbox runtime connection.
 * These replace the @webcontainer/api types.
 */

// Base protocol types
export interface WSMessage {
  id: string;
  type: string;
  timestamp: number;
  payload: unknown;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface WSRequest extends WSMessage {
  type: `${string}:req`;
}

export interface WSResponse extends WSMessage {
  type: `${string}:res`;
  requestId: string;
}

export interface WSEvent extends WSMessage {
  type: `${string}:event`;
}

// Filesystem
export interface FileWriteRequest extends WSRequest {
  type: 'fs:write:req';
  payload: {
    path: string;
    content: string;
    encoding: 'utf8' | 'base64';
    writeId?: string;
  };
}

export interface FileWriteResponse extends WSResponse {
  type: 'fs:write:res';
  payload: { success: boolean };
}

export interface FileReadRequest extends WSRequest {
  type: 'fs:read:req';
  payload: {
    path: string;
    encoding?: 'utf8' | 'base64';
  };
}

export interface FileReadResponse extends WSResponse {
  type: 'fs:read:res';
  payload: {
    content: string;
    isBinary: boolean;
    encoding: 'utf8' | 'base64';
  };
}

export interface FileMkdirRequest extends WSRequest {
  type: 'fs:mkdir:req';
  payload: { path: string };
}

export interface FileMkdirResponse extends WSResponse {
  type: 'fs:mkdir:res';
  payload: { success: boolean };
}

export interface FileSyncRequest extends WSRequest {
  type: 'fs:sync:req';
  payload: {
    include: string[];
    exclude: string[];
    includeContent: boolean;
  };
}

export interface FileSyncResponse extends WSResponse {
  type: 'fs:sync:res';
  payload: {
    files: Array<{
      path: string;
      type: 'file' | 'folder';
      content?: string;
      isBinary?: boolean;
      size?: number;
      mtime?: number;
    }>;
  };
}

export interface FileChangeEvent extends WSEvent {
  type: 'fs:change:event';
  payload: {
    eventType: 'add_file' | 'change' | 'remove_file' | 'add_dir' | 'remove_dir' | 'update_directory';
    path: string;
    content?: string;
    isBinary?: boolean;
    writeId?: string;
  };
}

// Terminal
export interface TerminalCreateRequest extends WSRequest {
  type: 'terminal:create:req';
  payload: {
    cols: number;
    rows: number;
    shell?: string;
    cwd?: string;
    env?: Record<string, string>;
  };
}

export interface TerminalCreateResponse extends WSResponse {
  type: 'terminal:create:res';
  payload: { terminalId: string };
}

export interface TerminalInputRequest extends WSRequest {
  type: 'terminal:input:req';
  payload: {
    terminalId: string;
    data: string;
  };
}

export interface TerminalInputResponse extends WSResponse {
  type: 'terminal:input:res';
  payload: { success: boolean };
}

export interface TerminalOutputEvent extends WSEvent {
  type: 'terminal:output:event';
  payload: {
    terminalId: string;
    data: string;
  };
}

export interface TerminalResizeRequest extends WSRequest {
  type: 'terminal:resize:req';
  payload: {
    terminalId: string;
    cols: number;
    rows: number;
  };
}

export interface TerminalResizeResponse extends WSResponse {
  type: 'terminal:resize:res';
  payload: { success: boolean };
}

export interface TerminalCloseRequest extends WSRequest {
  type: 'terminal:close:req';
  payload: { terminalId: string };
}

export interface TerminalExitEvent extends WSEvent {
  type: 'terminal:exit:event';
  payload: {
    terminalId: string;
    exitCode: number;
  };
}

// Shell
export interface ShellExecRequest extends WSRequest {
  type: 'shell:exec:req';
  payload: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    streamOutput?: boolean;
    timeout?: number;
  };
}

export interface ShellExecResponse extends WSResponse {
  type: 'shell:exec:res';
  payload: {
    exitCode: number;
    stdout?: string;
    stderr?: string;
    duration: number;
    killed?: boolean;
  };
}

export interface ShellOutputEvent extends WSEvent {
  type: 'shell:output:event';
  payload: {
    requestId: string;
    stream: 'stdout' | 'stderr';
    data: string;
  };
}

export interface ShellKillRequest extends WSRequest {
  type: 'shell:kill:req';
  payload: {
    requestId: string;
    signal?: string;
  };
}

// Port
export interface PortOpenEvent extends WSEvent {
  type: 'port:open:event';
  payload: {
    port: number;
    url: string;
    protocol: 'http' | 'https';
  };
}

export interface PortCloseEvent extends WSEvent {
  type: 'port:close:event';
  payload: { port: number };
}

export interface PortListRequest extends WSRequest {
  type: 'port:list:req';
  payload: Record<string, never>;
}

export interface PortListResponse extends WSResponse {
  type: 'port:list:res';
  payload: {
    ports: Array<{
      port: number;
      url: string;
      protocol: 'http' | 'https';
      status: 'open' | 'closed';
    }>;
  };
}

// System
export interface SystemPingRequest extends WSRequest {
  type: 'system:ping:req';
  payload: Record<string, never>;
}

export interface SystemPingResponse extends WSResponse {
  type: 'system:ping:res';
  payload: {
    timestamp: number;
    uptime: number;
  };
}

export interface SystemReadyEvent extends WSEvent {
  type: 'system:ready:event';
  payload: {
    sessionId: string;
    containerId: string;
    workdir: string;
  };
}

export interface SystemErrorEvent extends WSEvent {
  type: 'system:error:event';
  payload: {
    code: string;
    message: string;
    details?: unknown;
  };
}

// Connection interface
export type WSMessageHandler = (message: WSMessage) => void;

export interface RuntimeConnection {
  request<T extends WSResponse = WSResponse>(
    req: Omit<WSRequest, 'id' | 'timestamp'>
  ): Promise<T>;
  on(eventType: string, handler: WSMessageHandler): void;
  off(eventType: string, handler: WSMessageHandler): void;
  isConnected(): boolean;
  close(): void;
  getSession(): { sessionId: string; containerId: string; workdir: string };
}

export interface RuntimeConfig {
  wsEndpoint: string;
  authToken?: string;
  reconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  requestTimeout?: number;
  pingInterval?: number;
}

export enum RuntimeErrorCode {
  UNAUTHORIZED = 'UNAUTHORIZED',
  TIMEOUT = 'TIMEOUT',
  CONNECTION_LOST = 'CONNECTION_LOST',
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  PERMISSION_DENIED = 'PERMISSION_DENIED',
  TERMINAL_NOT_FOUND = 'TERMINAL_NOT_FOUND',
  COMMAND_FAILED = 'COMMAND_FAILED',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  INVALID_REQUEST = 'INVALID_REQUEST',
  CONTAINER_ERROR = 'CONTAINER_ERROR',
}

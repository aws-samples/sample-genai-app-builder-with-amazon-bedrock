import { execSync } from 'node:child_process';
import {
  createResponse,
  createEvent,
  type WSMessage,
  type WSResponse,
  type WSEvent,
} from '../protocol.js';

export type EventEmitter = (event: WSEvent) => void;

export interface PortInfo {
  port: number;
  pid?: number;
}

// Range of ports to monitor
const PORT_MIN = 3000;
const PORT_MAX = 9999;
const SCAN_INTERVAL_MS = 1000;

/**
 * Detects listening TCP ports by polling `ss -tlnp`.
 */
export class PortDetector {
  private knownPorts: Map<number, PortInfo> = new Map();
  private emit: EventEmitter;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private execFn: (cmd: string) => string;

  constructor(
    emit: EventEmitter,
    execFn?: (cmd: string) => string
  ) {
    this.emit = emit;
    this.execFn = execFn ?? ((cmd: string) => execSync(cmd, { encoding: 'utf-8' }));
  }

  /**
   * Update the event emitter (e.g. after WebSocket reconnect).
   * Preserves existing knownPorts and scanning interval.
   */
  setEmitter(newEmit: EventEmitter): void {
    this.emit = newEmit;
  }

  /**
   * Parse the output of `ss -tlnp` and return port/pid pairs
   * within the monitored range.
   */
  parseSsOutput(output: string): PortInfo[] {
    const ports: PortInfo[] = [];
    const lines = output.split('\n');

    for (const line of lines) {
      // Match lines with listening sockets – look for the local address:port pattern
      // ss output format: State  Recv-Q  Send-Q  Local Address:Port  Peer Address:Port  Process
      const addrMatch = line.match(/\s(\*|0\.0\.0\.0|::|\[::\]|127\.0\.0\.1):(\d+)\s/);
      if (!addrMatch) continue;

      const port = parseInt(addrMatch[2], 10);
      if (port < PORT_MIN || port > PORT_MAX) continue;

      // Try to extract PID from the process column
      let pid: number | undefined;
      const pidMatch = line.match(/pid=(\d+)/);
      if (pidMatch) {
        pid = parseInt(pidMatch[1], 10);
      }

      // Deduplicate within the same scan
      if (!ports.some((p) => p.port === port)) {
        ports.push({ port, pid });
      }
    }

    return ports;
  }

  /**
   * Run a single scan cycle: detect new/removed ports and emit events.
   */
  scan(): void {
    let output: string;
    try {
      output = this.execFn('ss -tlnp 2>/dev/null');
    } catch {
      // ss might not be available – skip this scan
      return;
    }

    const currentPorts = this.parseSsOutput(output);
    const currentPortSet = new Set(currentPorts.map((p) => p.port));

    // Detect newly opened ports
    for (const info of currentPorts) {
      if (!this.knownPorts.has(info.port)) {
        this.knownPorts.set(info.port, info);
        this.emit(
          createEvent('port:open:event', {
            port: info.port,
            url: `http://localhost:${info.port}`,
            protocol: 'http',
          })
        );
      }
    }

    // Detect closed ports
    for (const [port] of this.knownPorts) {
      if (!currentPortSet.has(port)) {
        this.knownPorts.delete(port);
        this.emit(
          createEvent('port:close:event', { port })
        );
      }
    }
  }

  /**
   * Start the polling interval.
   */
  start(intervalMs: number = SCAN_INTERVAL_MS): void {
    if (this.intervalHandle) return;
    this.scan(); // Initial scan
    this.intervalHandle = setInterval(() => this.scan(), intervalMs);
  }

  /**
   * Stop the polling interval.
   */
  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    this.knownPorts.clear();
  }

  /**
   * Handle port:list:req – return currently known ports.
   */
  handleList(msg: WSMessage): WSResponse {
    const ports = Array.from(this.knownPorts.values());
    return createResponse(msg.id, 'port:list:res', { ports });
  }

  /**
   * Route a port:* message to the correct handler.
   */
  handle(msg: WSMessage): WSResponse {
    const action = msg.type.split(':')[1];

    switch (action) {
      case 'list':
        return this.handleList(msg);
      default:
        throw new Error(`Unknown port action: ${action}`);
    }
  }
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PortDetector } from '../src/handlers/port-detector.js';
import type { WSMessage, WSEvent } from '../src/protocol.js';

function makeMsg(type: string, payload: Record<string, unknown>): WSMessage {
  return {
    id: randomUUID(),
    type,
    timestamp: Date.now(),
    payload,
  };
}

// Realistic ss -tlnp output
const SS_OUTPUT_TWO_PORTS = `State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*     users:(("node",pid=1234,fd=20))
LISTEN 0      511          0.0.0.0:5173       0.0.0.0:*     users:(("vite",pid=5678,fd=22))
`;

const SS_OUTPUT_ONE_PORT = `State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN 0      511          0.0.0.0:3000       0.0.0.0:*     users:(("node",pid=1234,fd=20))
`;

const SS_OUTPUT_OUT_OF_RANGE = `State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
LISTEN 0      511          0.0.0.0:22         0.0.0.0:*     users:(("sshd",pid=100,fd=3))
LISTEN 0      511          0.0.0.0:80         0.0.0.0:*     users:(("nginx",pid=200,fd=5))
`;

const SS_OUTPUT_EMPTY = `State  Recv-Q Send-Q  Local Address:Port   Peer Address:Port  Process
`;

describe('PortDetector', () => {
  let events: WSEvent[];
  let emit: (event: WSEvent) => void;

  beforeEach(() => {
    events = [];
    emit = (event: WSEvent) => events.push(event);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('parseSsOutput', () => {
    it('parses two listening ports', () => {
      const detector = new PortDetector(emit, () => '');
      const ports = detector.parseSsOutput(SS_OUTPUT_TWO_PORTS);

      expect(ports).toHaveLength(2);
      expect(ports[0]).toEqual({ port: 3000, pid: 1234 });
      expect(ports[1]).toEqual({ port: 5173, pid: 5678 });
    });

    it('ignores ports outside 3000-9999 range', () => {
      const detector = new PortDetector(emit, () => '');
      const ports = detector.parseSsOutput(SS_OUTPUT_OUT_OF_RANGE);

      expect(ports).toHaveLength(0);
    });

    it('handles empty output', () => {
      const detector = new PortDetector(emit, () => '');
      const ports = detector.parseSsOutput(SS_OUTPUT_EMPTY);

      expect(ports).toHaveLength(0);
    });
  });

  describe('scan', () => {
    it('emits port:open:event for new ports', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_TWO_PORTS);
      detector.scan();

      const openEvents = events.filter((e) => e.type === 'port:open:event');
      expect(openEvents).toHaveLength(2);
      expect(openEvents[0].payload.port).toBe(3000);
      expect(openEvents[0].payload.url).toBe('http://localhost:3000');
      expect(openEvents[0].payload.protocol).toBe('http');
      expect(openEvents[1].payload.port).toBe(5173);
    });

    it('does not re-emit for already-known ports', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_TWO_PORTS);
      detector.scan();
      events.length = 0; // Clear

      detector.scan();
      expect(events).toHaveLength(0);
    });

    it('emits port:close:event when a port disappears', () => {
      let output = SS_OUTPUT_TWO_PORTS;
      const detector = new PortDetector(emit, () => output);

      detector.scan();
      events.length = 0;

      // Port 5173 goes away
      output = SS_OUTPUT_ONE_PORT;
      detector.scan();

      const closeEvents = events.filter((e) => e.type === 'port:close:event');
      expect(closeEvents).toHaveLength(1);
      expect(closeEvents[0].payload.port).toBe(5173);
    });

    it('handles ss failure gracefully', () => {
      const detector = new PortDetector(emit, () => {
        throw new Error('ss not found');
      });

      // Should not throw
      detector.scan();
      expect(events).toHaveLength(0);
    });
  });

  describe('start / stop', () => {
    it('runs initial scan on start', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_ONE_PORT);
      detector.start(1000);

      expect(events.filter((e) => e.type === 'port:open:event')).toHaveLength(1);
      detector.stop();
    });

    it('scans on interval', () => {
      let callCount = 0;
      const detector = new PortDetector(emit, () => {
        callCount++;
        return SS_OUTPUT_EMPTY;
      });

      detector.start(500);
      expect(callCount).toBe(1); // Initial scan

      vi.advanceTimersByTime(500);
      expect(callCount).toBe(2);

      vi.advanceTimersByTime(500);
      expect(callCount).toBe(3);

      detector.stop();
    });

    it('stop clears known ports', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_ONE_PORT);
      detector.start(1000);
      detector.stop();

      const msg = makeMsg('port:list:req', {});
      const res = detector.handleList(msg);
      expect((res.payload.ports as unknown[]).length).toBe(0);
    });
  });

  describe('setEmitter', () => {
    it('routes events through the new emitter after swap', () => {
      const eventsA: WSEvent[] = [];
      const eventsB: WSEvent[] = [];
      const emitA = (event: WSEvent) => eventsA.push(event);
      const emitB = (event: WSEvent) => eventsB.push(event);

      let output = SS_OUTPUT_ONE_PORT;
      const detector = new PortDetector(emitA, () => output);

      // First scan — events go to emitter A
      detector.scan();
      expect(eventsA.filter((e) => e.type === 'port:open:event')).toHaveLength(1);
      expect(eventsB).toHaveLength(0);

      // Swap emitter
      detector.setEmitter(emitB);

      // Add a new port — events should go to emitter B
      output = SS_OUTPUT_TWO_PORTS;
      detector.scan();

      const bOpens = eventsB.filter((e) => e.type === 'port:open:event');
      expect(bOpens).toHaveLength(1); // Only port 5173 is new
      expect(bOpens[0].payload.port).toBe(5173);

      // Emitter A should not have received the new event
      expect(eventsA.filter((e) => e.type === 'port:open:event')).toHaveLength(1); // Still just the original

      detector.stop();
    });

    it('preserves known ports across emitter swap', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_TWO_PORTS);
      detector.scan();

      // Swap emitter
      const newEvents: WSEvent[] = [];
      detector.setEmitter((e) => newEvents.push(e));

      // List should still show both ports
      const msg = makeMsg('port:list:req', {});
      const res = detector.handleList(msg);
      const ports = res.payload.ports as Array<{ port: number }>;
      expect(ports).toHaveLength(2);
      expect(ports.map((p) => p.port).sort()).toEqual([3000, 5173]);

      detector.stop();
    });
  });

  describe('handleList', () => {
    it('returns currently known ports', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_TWO_PORTS);
      detector.scan();

      const msg = makeMsg('port:list:req', {});
      const res = detector.handleList(msg);

      expect(res.type).toBe('port:list:res');
      const ports = res.payload.ports as Array<{ port: number; pid?: number }>;
      expect(ports).toHaveLength(2);
      expect(ports.map((p) => p.port).sort()).toEqual([3000, 5173]);
    });
  });

  describe('handle (router)', () => {
    it('routes list messages', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_EMPTY);
      const msg = makeMsg('port:list:req', {});
      const res = detector.handle(msg);
      expect(res.type).toBe('port:list:res');
    });

    it('throws for unknown action', () => {
      const detector = new PortDetector(emit, () => SS_OUTPUT_EMPTY);
      const msg = makeMsg('port:unknown:req', {});
      expect(() => detector.handle(msg)).toThrow('Unknown port action');
    });
  });
});

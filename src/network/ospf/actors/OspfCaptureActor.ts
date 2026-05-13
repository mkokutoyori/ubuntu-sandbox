/**
 * OspfCaptureActor — tcpdump-like packet recorder.
 *
 * Subscribes to `ospf.packet.outgoing` and `ospf.packet.received` and
 * keeps a bounded ring buffer of the last N packets. This is the
 * direct payoff of the packet-egress reactive inversion: a brand-new
 * "OSPF capture" feature lives in ~80 LoC, with **zero modification**
 * to `OSPFEngine.ts`.
 *
 * Possible use cases:
 *   - Live "show ospf packets" CLI command.
 *   - Trace snapshots for §11.2.5 regression tests.
 *   - Replay scenarios (the captured trace is rejouable on a fresh
 *     engine via `bus.publish(...)`).
 *   - IDS / fuzzing: feed the captured packets through anomaly
 *     detection and resend mutated variants.
 */

import type { IEventBus, Unsubscribe as BusUnsubscribe } from '@/events/EventBus';
import type { OSPFPacket } from '../types';

export interface CapturedOspfPacket {
  /** 'in' = ingress (received), 'out' = egress (sent or to be sent). */
  readonly direction: 'in' | 'out';
  /** Wall-clock timestamp when the actor observed the event. */
  readonly timestamp: number;
  readonly routerId: string;
  readonly processId: number;
  readonly iface: string;
  /** Source IP for ingress, destination IP for egress. */
  readonly peerIp: string;
  readonly packet: OSPFPacket;
}

export interface OspfCaptureFilter {
  /** Match a specific router id (multi-engine setups). */
  readonly routerId?: string;
  /** Match a specific interface. */
  readonly iface?: string;
  /** Restrict direction. */
  readonly direction?: 'in' | 'out';
  /** Restrict to a specific OSPF packet type (1=Hello, 2=DD, 3=LSR, 4=LSU, 5=LSAck). */
  readonly packetType?: number;
}

export class OspfCaptureActor {
  private readonly subscriptions: BusUnsubscribe[] = [];
  private readonly buffer: CapturedOspfPacket[] = [];

  constructor(
    private readonly bus: IEventBus,
    private readonly maxEntries: number = 1000,
  ) {}

  start(): void {
    if (this.subscriptions.length > 0) return;
    this.subscriptions.push(
      this.bus.subscribe('ospf.packet.outgoing', (e) => {
        this.append({
          direction: 'out',
          timestamp: Date.now(),
          routerId: e.payload.routerId,
          processId: e.payload.processId,
          iface: e.payload.iface,
          peerIp: e.payload.destIp,
          packet: e.payload.packet,
        });
      }),
      this.bus.subscribe('ospf.packet.received', (e) => {
        this.append({
          direction: 'in',
          timestamp: Date.now(),
          routerId: e.payload.routerId,
          processId: e.payload.processId,
          iface: e.payload.iface,
          peerIp: e.payload.srcIp,
          packet: e.payload.packet,
        });
      }),
    );
  }

  stop(): void {
    for (const u of this.subscriptions) u();
    this.subscriptions.length = 0;
  }

  /** Total number of packets currently held in the ring buffer. */
  size(): number {
    return this.buffer.length;
  }

  /** All captured packets, optionally filtered. Returns a copy. */
  getCapture(filter?: OspfCaptureFilter): CapturedOspfPacket[] {
    if (!filter) return [...this.buffer];
    return this.buffer.filter((p) => {
      if (filter.routerId !== undefined && p.routerId !== filter.routerId) return false;
      if (filter.iface !== undefined && p.iface !== filter.iface) return false;
      if (filter.direction !== undefined && p.direction !== filter.direction) return false;
      if (filter.packetType !== undefined && p.packet.packetType !== filter.packetType) return false;
      return true;
    });
  }

  /** Drop the buffered capture but keep the subscriptions live. */
  clear(): void {
    this.buffer.length = 0;
  }

  private append(entry: CapturedOspfPacket): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxEntries) {
      // Bounded: drop the oldest half when we hit the cap.
      this.buffer.splice(0, Math.floor(this.maxEntries / 2));
    }
  }
}

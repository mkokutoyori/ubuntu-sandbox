import type { EthernetFrame, IPv4Packet, UDPPacket, ICMPPacket } from '../../../core/types';
import type { TcpSegment } from '../../../tcp/types';
import { lineageOf, orderedDelivery } from '../../../hardware/FrameLineage';

export type CaptureDirection = 'in' | 'out';

export interface CapturedFrame {
  readonly seq: number;
  readonly at: number;
  readonly iface: string;
  readonly direction: CaptureDirection;
  readonly frame: EthernetFrame;
}

export interface CaptureQuery {
  readonly iface: string;
  readonly matches: (entry: CapturedFrame) => boolean;
  readonly limit: number;
}

const RING_CAPACITY = 512;

export class PacketCapture {
  private readonly frames: CapturedFrame[] = [];

  private readonly listeners = new Set<(entry: CapturedFrame) => void>();

  private byteBudget: number | null = null;

  private storedBytes = 0;

  setByteBudget(bytes: number | null): void {
    this.byteBudget = bytes !== null && bytes > 0 ? bytes : null;
    this.trim();
  }

  storedByteCount(): number { return this.storedBytes; }

  record(raw: Omit<CapturedFrame, 'seq'>): void {
    const entry: CapturedFrame = { ...raw, seq: lineageOf(raw.frame).seq };
    this.frames.push(entry);
    this.storedBytes += frameBytes(entry.frame);
    this.trim();
    for (const listener of [...this.listeners]) listener(entry);
  }

  private trim(): void {
    while (this.frames.length > RING_CAPACITY) this.dropOldest();
    while (this.byteBudget !== null && this.storedBytes > this.byteBudget
      && this.frames.length > 0) {
      this.dropOldest();
    }
  }

  private dropOldest(): void {
    const gone = this.frames.shift();
    if (gone) this.storedBytes -= frameBytes(gone.frame);
  }

  observe(listener: (entry: CapturedFrame) => void): () => void {
    let lastAt = Number.NEGATIVE_INFINITY;
    const delivery = orderedDelivery<CapturedFrame>((entry) => {
      lastAt = Math.max(lastAt, entry.at);
      listener(entry.at === lastAt ? entry : { ...entry, at: lastAt });
    });
    this.listeners.add(delivery.push);
    return () => { delivery.flush(); this.listeners.delete(delivery.push); };
  }

  clear(): void {
    this.frames.length = 0;
    this.storedBytes = 0;
  }

  count(): number {
    return this.frames.length;
  }

  select(query: CaptureQuery): readonly CapturedFrame[] {
    const kept: CapturedFrame[] = [];
    const ordered = this.frames.map((entry, index) => ({ entry, index }))
      .sort((a, b) => a.entry.seq - b.entry.seq || a.index - b.index);
    let lastAt = Number.NEGATIVE_INFINITY;
    for (const { entry: stored } of ordered) {
      lastAt = Math.max(lastAt, stored.at);
      const entry = stored.at === lastAt ? stored : { ...stored, at: lastAt };
      if (query.iface !== 'any' && entry.iface !== query.iface) continue;
      if (!query.matches(entry)) continue;
      kept.push(entry);
      if (query.limit > 0 && kept.length >= query.limit) break;
    }
    return Object.freeze(kept);
  }
}

export function portsOf(packet: IPv4Packet): { source: number; destination: number } {
  const payload = packet.payload as TcpSegment | UDPPacket | null | undefined;
  if (payload?.type === 'tcp' || payload?.type === 'udp') {
    return { source: payload.sourcePort, destination: payload.destinationPort };
  }
  return { source: 0, destination: 0 };
}

export function icmpOf(packet: IPv4Packet): ICMPPacket | undefined {
  const payload = packet.payload as ICMPPacket | null | undefined;
  return payload?.type === 'icmp' ? payload : undefined;
}

function frameBytes(frame: EthernetFrame): number {
  const payload = frame.payload as { totalLength?: number } | undefined;
  return ETHERNET_HEADER_BYTES + (payload?.totalLength ?? 46);
}

const ETHERNET_HEADER_BYTES = 18;

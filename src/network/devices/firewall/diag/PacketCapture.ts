import type { EthernetFrame, IPv4Packet, TCPPacket, UDPPacket, ICMPPacket } from '../../../core/types';
import { IP_PROTO_ICMP, IP_PROTO_TCP, IP_PROTO_UDP, ETHERTYPE_ARP, ETHERTYPE_IPV4 } from '../../../core/types';

export type CaptureDirection = 'in' | 'out';

export interface CapturedFrame {
  readonly at: number;
  readonly iface: string;
  readonly direction: CaptureDirection;
  readonly frame: EthernetFrame;
}

export interface CaptureFilter {
  readonly host?: string;
  readonly source?: string;
  readonly destination?: string;
  readonly port?: number;
  readonly protocol?: number;
}

export interface CaptureQuery {
  readonly iface: string;
  readonly filter: CaptureFilter;
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

  record(entry: CapturedFrame): void {
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
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
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
    for (const entry of this.frames) {
      if (query.iface !== 'any' && entry.iface !== query.iface) continue;
      if (!frameMatches(entry.frame, query.filter)) continue;
      kept.push(entry);
      if (query.limit > 0 && kept.length >= query.limit) break;
    }
    return Object.freeze(kept);
  }
}

export function parseCaptureFilter(expression: string): CaptureFilter | null {
  const text = expression.trim().replace(/^['"]|['"]$/g, '').trim();
  if (text === '' || text.toLowerCase() === 'none') return {};

  const filter: {
    host?: string; source?: string; destination?: string;
    port?: number; protocol?: number;
  } = {};
  const words = text.split(/\s+/);

  for (let index = 0; index < words.length; index++) {
    const word = words[index].toLowerCase();
    if (word === 'and' || word === 'or') continue;

    const value = words[index + 1];
    switch (word) {
      case 'host': filter.host = value; index++; break;
      case 'src': filter.source = nextAddress(words, index); index++; break;
      case 'dst': filter.destination = nextAddress(words, index); index++; break;
      case 'port': filter.port = Number.parseInt(value ?? '', 10); index++; break;
      case 'tcp': filter.protocol = IP_PROTO_TCP; break;
      case 'udp': filter.protocol = IP_PROTO_UDP; break;
      case 'icmp': filter.protocol = IP_PROTO_ICMP; break;
      case 'arp': filter.protocol = -1; break;
      default: return null;
    }
  }

  if (filter.port !== undefined && !Number.isFinite(filter.port)) return null;
  return Object.freeze(filter);
}

function nextAddress(words: readonly string[], index: number): string | undefined {
  const next = words[index + 1];
  if (next === undefined) return undefined;
  return next.toLowerCase() === 'host' ? words[index + 2] : next;
}

export function frameMatches(frame: EthernetFrame, filter: CaptureFilter): boolean {
  if (filter.protocol === -1) return frame.etherType === ETHERTYPE_ARP;
  if (frame.etherType !== ETHERTYPE_IPV4) {
    return filter.host === undefined && filter.source === undefined
      && filter.destination === undefined && filter.port === undefined
      && filter.protocol === undefined;
  }

  const packet = frame.payload as IPv4Packet | undefined;
  if (packet?.type !== 'ipv4') return false;

  const source = packet.sourceIP.toString();
  const destination = packet.destinationIP.toString();

  if (filter.host !== undefined && source !== filter.host && destination !== filter.host) {
    return false;
  }
  if (filter.source !== undefined && source !== filter.source) return false;
  if (filter.destination !== undefined && destination !== filter.destination) return false;
  if (filter.protocol !== undefined && packet.protocol !== filter.protocol) return false;
  if (filter.port === undefined) return true;

  const ports = portsOf(packet);
  return ports.source === filter.port || ports.destination === filter.port;
}

export function portsOf(packet: IPv4Packet): { source: number; destination: number } {
  const payload = packet.payload as TCPPacket | UDPPacket | null | undefined;
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

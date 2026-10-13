import { FragmentEcn, type FragmentEcnVerdict } from '../../core/IpHeaderFields';
import type { NetworkPdu } from '../../core/NetworkPdu';
import { IP_PROTO_IPV6_FRAGMENT, type IPv6Packet } from '../../core/types';
import { IPV6_HEADER_BYTES, ipv6PacketBytes } from './Ipv6Ingress';

export const IPV6_FRAGMENT_HEADER_BYTES = 8;
export const IPV6_MAX_PAYLOAD_BYTES = 65535;
export const IPV6_REASSEMBLY_TIMEOUT_MS = 60_000;
export const IPV6_REASSEMBLY_HIGH_THRESHOLD_BYTES = 4 * 1024 * 1024;
export const IPV6_REASSEMBLY_LOW_THRESHOLD_BYTES = 3 * 1024 * 1024;

const PAYLOAD_LENGTH_FIELD_OFFSET = 4;
const FRAGMENT_OFFSET_FIELD_OFFSET = IPV6_HEADER_BYTES + 2;

export interface IPv6FragmentData extends NetworkPdu {
  type: 'ipv6-fragment-data';
  length: number;
}

export interface IPv6FragmentHeader extends NetworkPdu {
  type: 'ipv6-fragment';
  nextHeader: number;
  fragmentOffset: number;
  moreFragments: boolean;
  identification: number;
  length: number;
  payload: unknown;
}

export function isIPv6FragmentHeader(value: unknown): value is IPv6FragmentHeader {
  return !!value && typeof value === 'object' && (value as NetworkPdu).type === 'ipv6-fragment';
}

export function ipv6FragmentOf(packet: IPv6Packet): IPv6FragmentHeader | null {
  if (packet.nextHeader !== IP_PROTO_IPV6_FRAGMENT) return null;
  return isIPv6FragmentHeader(packet.payload) ? packet.payload : null;
}

export function ipv6FirstFragmentView(packet: IPv6Packet): IPv6Packet | null {
  const header = ipv6FragmentOf(packet);
  if (header === null || header.fragmentOffset !== 0) return null;
  return {
    ...packet,
    nextHeader: header.nextHeader,
    payloadLength: packet.payloadLength - IPV6_FRAGMENT_HEADER_BYTES,
    payload: header.payload,
  };
}

export function ipv6FragmentCapacity(mtu: number): number {
  return Math.floor((mtu - IPV6_HEADER_BYTES - IPV6_FRAGMENT_HEADER_BYTES) / 8) * 8;
}

export function fragmentIPv6(packet: IPv6Packet, mtu: number, nextIdentification: () => number): IPv6Packet[] {
  const payloadBytes = packet.payloadLength;
  if (ipv6PacketBytes(packet) <= mtu) return [packet];
  const capacity = ipv6FragmentCapacity(mtu);
  if (capacity <= 0) return [packet];

  const identification = nextIdentification();
  const fragments: IPv6Packet[] = [];
  for (let offset = 0; offset < payloadBytes; offset += capacity) {
    const length = Math.min(capacity, payloadBytes - offset);
    const header: IPv6FragmentHeader = {
      type: 'ipv6-fragment',
      nextHeader: packet.nextHeader,
      fragmentOffset: offset / 8,
      moreFragments: offset + length < payloadBytes,
      identification,
      length,
      payload: offset === 0 ? packet.payload : ({ type: 'ipv6-fragment-data', length } satisfies IPv6FragmentData),
    };
    fragments.push({
      ...packet,
      nextHeader: IP_PROTO_IPV6_FRAGMENT,
      payloadLength: IPV6_FRAGMENT_HEADER_BYTES + length,
      payload: header,
    });
  }
  return fragments;
}

export interface Ipv6ReassemblyLimits {
  highThresholdBytes: () => number;
}

export type Ipv6DiscardReason = 'overlap' | 'inconsistent-end' | 'empty-fragment' | 'invalid-ecn';

export type Ipv6ReassemblyOutcome =
  | { kind: 'passthrough'; packet: IPv6Packet }
  | { kind: 'atomic'; packet: IPv6Packet }
  | { kind: 'refused' }
  | { kind: 'malformed'; key: string; created: boolean; pointer: number }
  | { kind: 'queued'; key: string; created: boolean }
  | { kind: 'duplicate'; key: string; created: boolean }
  | { kind: 'discarded'; key: string; created: boolean; reason: Ipv6DiscardReason }
  | { kind: 'complete'; key: string; created: boolean; packet: IPv6Packet };

export interface Ipv6ExpiredQueue {
  readonly first: IPv6Packet | null;
  readonly ingress: string;
}

interface HeldSlice {
  readonly start: number;
  readonly end: number;
  readonly packet: IPv6Packet;
}

interface FragmentRun {
  start: number;
  end: number;
}

interface ReassemblyQueue {
  readonly ingress: string;
  slices: HeldSlice[];
  runs: FragmentRun[];
  length: number;
  lastSeen: boolean;
  held: number;
  readonly ecn: FragmentEcn;
}

export function ipv6ReassemblyKey(packet: IPv6Packet, header: IPv6FragmentHeader, ingress: string): string {
  const scoped = packet.destinationIP.isMulticast() || packet.destinationIP.isLinkLocal();
  return `${packet.sourceIP}|${packet.destinationIP}|${header.identification}${scoped ? `|${ingress}` : ''}`;
}

function assemble(head: IPv6Packet, totalLength: number, verdict: FragmentEcnVerdict): IPv6Packet {
  const header = ipv6FragmentOf(head)!;
  return {
    ...head,
    nextHeader: header.nextHeader,
    payloadLength: totalLength,
    payload: header.payload,
    trafficClass: verdict === 'congestion-experienced' ? head.trafficClass | 0b11 : head.trafficClass,
  };
}

export class IPv6Reassembler {
  private readonly queues = new Map<string, ReassemblyQueue>();
  private heldBytes = 0;

  constructor(private readonly limits: Ipv6ReassemblyLimits) {}

  bytesHeld(): number {
    return this.heldBytes;
  }

  queuesHeld(): number {
    return this.queues.size;
  }

  add(packet: IPv6Packet, ingress: string): Ipv6ReassemblyOutcome {
    const header = ipv6FragmentOf(packet);
    if (header === null) return { kind: 'passthrough', packet };
    if (header.fragmentOffset === 0 && !header.moreFragments) {
      return { kind: 'atomic', packet: assemble(packet, header.length, 'keep') };
    }

    const limit = this.limits.highThresholdBytes();
    if (limit === 0 || this.heldBytes > limit) return { kind: 'refused' };

    const key = ipv6ReassemblyKey(packet, header, ingress);
    let queue = this.queues.get(key);
    const created = queue === undefined;
    if (queue === undefined) {
      queue = { ingress, slices: [], runs: [], length: 0, lastSeen: false, held: 0, ecn: new FragmentEcn() };
      this.queues.set(key, queue);
    }

    const start = header.fragmentOffset * 8;
    const end = start + header.length;
    if (end > IPV6_MAX_PAYLOAD_BYTES) {
      return { kind: 'malformed', key, created, pointer: FRAGMENT_OFFSET_FIELD_OFFSET };
    }

    if (!header.moreFragments) {
      if (end < queue.length || (queue.lastSeen && end !== queue.length)) {
        return this.kill(key, created, 'inconsistent-end');
      }
      queue.lastSeen = true;
      queue.length = end;
    } else {
      if (end % 8 !== 0) return { kind: 'malformed', key, created, pointer: PAYLOAD_LENGTH_FIELD_OFFSET };
      if (end > queue.length) {
        if (queue.lastSeen) return this.kill(key, created, 'inconsistent-end');
        queue.length = end;
      }
    }

    if (end === start) return this.kill(key, created, 'empty-fragment');

    const placement = this.place(queue, start, end);
    if (placement === 'duplicate') return { kind: 'duplicate', key, created };
    if (placement === 'overlap') return this.kill(key, created, 'overlap');

    queue.ecn.note(packet.trafficClass);
    queue.slices.push({ start, end, packet });
    queue.slices.sort((a, b) => a.start - b.start);
    const bytes = ipv6PacketBytes(packet);
    queue.held += bytes;
    this.heldBytes += bytes;

    const complete = queue.lastSeen && this.covered(queue) === queue.length;
    if (!complete) return { kind: 'queued', key, created };

    const verdict = queue.ecn.verdict;
    if (verdict === 'discard') return this.kill(key, created, 'invalid-ecn');
    const whole = assemble(queue.slices[0].packet, queue.length, verdict);
    this.release(key);
    return { kind: 'complete', key, created, packet: whole };
  }

  clear(): void {
    this.queues.clear();
    this.heldBytes = 0;
  }

  expire(key: string): Ipv6ExpiredQueue | null {
    const queue = this.queues.get(key);
    if (queue === undefined) return null;
    const first = queue.slices.length > 0 && queue.slices[0].start === 0 ? queue.slices[0].packet : null;
    this.release(key);
    return { first, ingress: queue.ingress };
  }

  private place(queue: ReassemblyQueue, start: number, end: number): 'free' | 'duplicate' | 'overlap' {
    const { runs } = queue;
    const tail = runs[runs.length - 1];
    if (tail === undefined) {
      runs.push({ start, end });
      return 'free';
    }
    if (end > tail.end) {
      if (start < tail.end) return 'overlap';
      if (start === tail.end) tail.end = end;
      else runs.push({ start, end });
      return 'free';
    }
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      if (end <= run.start) {
        runs.splice(index, 0, { start, end });
        return 'free';
      }
      if (start >= run.end) continue;
      return start >= run.start && end <= run.end ? 'duplicate' : 'overlap';
    }
    return 'free';
  }

  private covered(queue: ReassemblyQueue): number {
    let expected = 0;
    for (const slice of queue.slices) {
      if (slice.start !== expected) return -1;
      expected = slice.end;
    }
    return expected;
  }

  private kill(key: string, created: boolean, reason: Ipv6DiscardReason): Ipv6ReassemblyOutcome {
    this.release(key);
    return { kind: 'discarded', key, created, reason };
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    if (queue === undefined) return;
    this.heldBytes -= queue.held;
    this.queues.delete(key);
  }
}

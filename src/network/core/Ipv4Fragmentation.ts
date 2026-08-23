/**
 * IPv4 fragmentation and reassembly (RFC 791 §3.2).
 *
 * This simulator represents most upper-layer payloads as structured JS
 * objects rather than serialized bytes — `createIPv4Packet(..., payload,
 * payloadSize)` already tracks a datagram's size as a declared number
 * independent of the payload object it carries. Fragmentation follows the
 * same model: the first fragment (offset 0) carries the real upper-layer
 * object (so UDP/TCP/ICMP headers survive), while later fragments carry a
 * `IPv4FragmentData` placeholder that only declares how many bytes of
 * continuation data it holds. Reassembly reconstructs a single logical
 * datagram from the declared sizes, which is enough to drive MTU-correct
 * fragment counts, offsets, and end-to-end delivery without a byte-level
 * wire representation this codebase doesn't otherwise have.
 */

import { IPv4Packet, computeIPv4Checksum } from './types';
import type { NetworkPdu } from './NetworkPdu';

/** Header flag bits, matching the convention documented on `IPv4Packet.flags`. */
export const IPV4_FLAG_DF = 0b010;
export const IPV4_FLAG_MF = 0b100;

/** Placeholder payload for a non-first fragment — no upper-layer header lives here. */
export interface IPv4FragmentData extends NetworkPdu {
  type: 'ipv4-fragment-data';
  /** Declared byte length of this fragment's slice of the original payload. */
  length: number;
}

export function isIPv4FragmentData(payload: unknown): payload is IPv4FragmentData {
  return !!payload && typeof payload === 'object' && (payload as NetworkPdu).type === 'ipv4-fragment-data';
}

/** True when the datagram is larger than `mtu` and would need fragmenting. */
export function needsFragmentation(pkt: IPv4Packet, mtu: number): boolean {
  return pkt.totalLength > mtu;
}

/**
 * Split an oversized datagram into RFC 791 fragments that each fit `mtu`.
 * Returns `[pkt]` unchanged if it already fits. Does not consult the DF bit
 * — callers must only fragment when DF is clear.
 */
export function fragmentIPv4(pkt: IPv4Packet, mtu: number): IPv4Packet[] {
  const headerBytes = pkt.ihl * 4;
  if (pkt.totalLength <= mtu) return [pkt];

  const totalPayloadBytes = pkt.totalLength - headerBytes;
  const maxChunk = Math.floor((mtu - headerBytes) / 8) * 8;
  if (maxChunk <= 0) return [pkt];

  const fragments: IPv4Packet[] = [];
  let offsetBytes = 0;
  while (offsetBytes < totalPayloadBytes) {
    const chunk = Math.min(maxChunk, totalPayloadBytes - offsetBytes);
    const isLast = offsetBytes + chunk >= totalPayloadBytes;
    const frag: IPv4Packet = {
      ...pkt,
      totalLength: headerBytes + chunk,
      flags: isLast ? 0 : IPV4_FLAG_MF,
      fragmentOffset: offsetBytes / 8,
      payload: offsetBytes === 0 ? pkt.payload : { type: 'ipv4-fragment-data', length: chunk },
      headerChecksum: 0,
    };
    frag.headerChecksum = computeIPv4Checksum(frag);
    fragments.push(frag);
    offsetBytes += chunk;
  }
  return fragments;
}

export const REASSEMBLY_TIMEOUT_MS = 30_000;

export function isIPv4Fragment(pkt: IPv4Packet): boolean {
  return pkt.fragmentOffset !== 0 || (pkt.flags & IPV4_FLAG_MF) !== 0;
}

export function fragmentKey(pkt: IPv4Packet): string {
  return `${pkt.sourceIP.toString()}|${pkt.destinationIP.toString()}`
    + `|${pkt.protocol}|${pkt.identification}`;
}

interface PendingFragment {
  offsetBytes: number;
  lengthBytes: number;
  pkt: IPv4Packet;
}

interface PendingDatagram {
  firstSeenMs: number;
  fragments: PendingFragment[];
  lastOffsetSeen: number | null;
}

/**
 * Per-device fragment reassembly buffer, keyed by (src, dst, protocol,
 * identification) per RFC 791. Incomplete sets are dropped after
 * {@link REASSEMBLY_TIMEOUT_MS} of inactivity (RFC 792 fragment-reassembly
 * time exceeded); `onExpire` lets the caller emit that ICMP error.
 */
export class IPv4Reassembler {
  private readonly pending = new Map<string, PendingDatagram>();

  constructor(private readonly onExpire?: (firstFragment: IPv4Packet | null) => void) {}

  private key(pkt: IPv4Packet): string {
    return fragmentKey(pkt);
  }

  /**
   * Feed one arriving datagram. A non-fragment passes straight through.
   * Returns the reassembled datagram once every fragment has arrived,
   * `null` while the set is still incomplete.
   */
  add(pkt: IPv4Packet, nowMs: number = Date.now()): IPv4Packet | null {
    if (!isIPv4Fragment(pkt)) return pkt;

    this.purgeExpired(nowMs);

    const key = this.key(pkt);
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { firstSeenMs: nowMs, fragments: [], lastOffsetSeen: null };
      this.pending.set(key, entry);
    }
    const headerBytes = pkt.ihl * 4;
    const offsetBytes = pkt.fragmentOffset * 8;
    const lengthBytes = pkt.totalLength - headerBytes;
    entry.fragments = entry.fragments.filter(f => f.offsetBytes !== offsetBytes);
    entry.fragments.push({ offsetBytes, lengthBytes, pkt });
    entry.fragments.sort((a, b) => a.offsetBytes - b.offsetBytes);
    if ((pkt.flags & IPV4_FLAG_MF) === 0) entry.lastOffsetSeen = offsetBytes + lengthBytes;

    if (!this.isComplete(entry)) return null;

    this.pending.delete(key);
    return this.reassemble(entry);
  }

  private isComplete(entry: PendingDatagram): boolean {
    if (entry.lastOffsetSeen === null) return false;
    let expected = 0;
    for (const f of entry.fragments) {
      if (f.offsetBytes !== expected) return false;
      expected += f.lengthBytes;
    }
    return expected === entry.lastOffsetSeen;
  }

  private reassemble(entry: PendingDatagram): IPv4Packet {
    const first = entry.fragments[0].pkt;
    const totalPayloadBytes = entry.fragments.reduce((sum, f) => sum + f.lengthBytes, 0);
    const headerBytes = first.ihl * 4;
    const reassembled: IPv4Packet = {
      ...first,
      totalLength: headerBytes + totalPayloadBytes,
      flags: first.flags & IPV4_FLAG_DF,
      fragmentOffset: 0,
      headerChecksum: 0,
    };
    reassembled.headerChecksum = computeIPv4Checksum(reassembled);
    return reassembled;
  }

  forget(key: string): void { this.pending.delete(key); }

  /** Drop fragment sets idle for longer than the reassembly timeout. */
  purgeExpired(nowMs: number = Date.now()): void {
    for (const [key, entry] of this.pending) {
      if (nowMs - entry.firstSeenMs > REASSEMBLY_TIMEOUT_MS) {
        this.pending.delete(key);
        const firstFrag = entry.fragments.find(f => f.offsetBytes === 0)?.pkt ?? null;
        this.onExpire?.(firstFrag);
      }
    }
  }
}

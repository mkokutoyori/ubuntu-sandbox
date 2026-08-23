import type { IPv4Packet } from '../../../core/types';
import {
  IPv4Reassembler, REASSEMBLY_TIMEOUT_MS, fragmentKey, isIPv4Fragment,
} from '../../../core/Ipv4Fragmentation';

export const DEFAULT_FRAGMENT_MEM_MB = 32;
export const MIN_FRAGMENT_MEM_MB = 32;
export const MAX_FRAGMENT_MEM_MB = 2047;
const BYTES_PER_MB = 1024 * 1024;

export { REASSEMBLY_TIMEOUT_MS };

export interface ReassemblyCounters {
  readonly reasmTimeout: number;
  readonly reasmReqds: number;
  readonly reasmOKs: number;
  readonly reasmFails: number;
}

interface HeldSet {
  bytes: number;
  firstSeenMs: number;
}

export class FragmentReassembly {
  private readonly held = new Map<string, HeldSet>();
  private readonly engine: IPv4Reassembler;
  private thresholdBytes = DEFAULT_FRAGMENT_MEM_MB * BYTES_PER_MB;
  private thresholdMb = DEFAULT_FRAGMENT_MEM_MB;
  private heldBytes = 0;
  private reasmReqds = 0;
  private reasmOKs = 0;
  private reasmFails = 0;

  constructor() {
    this.engine = new IPv4Reassembler((firstFragment) => {
      if (firstFragment) this.release(fragmentKey(firstFragment));
      this.reasmFails++;
    });
  }

  setThresholdMegabytes(megabytes: number): void {
    this.thresholdMb = megabytes;
    this.thresholdBytes = megabytes * BYTES_PER_MB;
    this.enforceThreshold();
  }

  getThresholdMegabytes(): number { return this.thresholdMb; }

  bytesHeld(): number { return this.heldBytes; }

  counters(): ReassemblyCounters {
    return Object.freeze({
      reasmTimeout: REASSEMBLY_TIMEOUT_MS / 1000,
      reasmReqds: this.reasmReqds,
      reasmOKs: this.reasmOKs,
      reasmFails: this.reasmFails,
    });
  }

  accept(packet: IPv4Packet, nowMs: number): IPv4Packet | null {
    this.engine.purgeExpired(nowMs);
    if (!isIPv4Fragment(packet)) return packet;

    this.reasmReqds++;
    this.remember(packet, nowMs);
    this.enforceThreshold();

    const key = fragmentKey(packet);
    if (!this.held.has(key)) return null;

    const whole = this.engine.add(packet, nowMs);
    if (whole === null) return null;
    this.release(key);
    this.reasmOKs++;
    return whole;
  }

  private remember(packet: IPv4Packet, nowMs: number): void {
    const key = fragmentKey(packet);
    const set = this.held.get(key);
    const bytes = packet.totalLength;
    this.heldBytes += bytes;
    if (set) set.bytes += bytes;
    else this.held.set(key, { bytes, firstSeenMs: nowMs });
  }

  private release(key: string): void {
    const set = this.held.get(key);
    if (!set) return;
    this.heldBytes -= set.bytes;
    this.held.delete(key);
  }

  private enforceThreshold(): void {
    while (this.heldBytes > this.thresholdBytes && this.held.size > 0) {
      const oldestKey = this.held.keys().next().value as string;
      this.release(oldestKey);
      this.engine.forget(oldestKey);
      this.reasmFails++;
    }
  }
}

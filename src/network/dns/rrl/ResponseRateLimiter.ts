import { IPAddress, IPv6Address, SubnetMask } from '@/network/core/types';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';

export interface RateLimits {
  readonly responsesPerSecond: number;
  readonly errorsPerSecond: number;
  readonly windowSeconds: number;
  readonly ipv4PrefixLength: number;
  readonly ipv6PrefixLength: number;
  readonly leakRate: number;
  readonly truncateRate: number;
  readonly maximumResponsesPerWindow: number;
}

export type RateVerdict = 'send' | 'leak' | 'truncate' | 'drop';

export interface RateProbe {
  readonly source: IPAddress | IPv6Address;
  readonly imputedName: string;
  readonly error: boolean;
}

export const MAXIMUM_TRACKED_RESPONSES = 10000;

const MILLISECONDS_PER_SECOND = 1000;

interface Tally {
  recent: number[];
  windowStartMs: number;
  given: number;
  excess: number;
  lastSeenMs: number;
}

export function sourceBucket(source: IPAddress | IPv6Address, limits: RateLimits): string {
  return source instanceof IPAddress
    ? source.networkAddress(SubnetMask.fromCIDR(limits.ipv4PrefixLength)).toString()
    : source.getNetworkPrefix(limits.ipv6PrefixLength).toString();
}

export class ResponseRateLimiter {
  private readonly tallies = new Map<string, Tally>();
  private nextSweepAtMs = 0;

  constructor(private readonly now: () => number, private readonly capacity: number = MAXIMUM_TRACKED_RESPONSES) {}

  judge(probe: RateProbe, limits: RateLimits): RateVerdict {
    const nowMs = this.now();
    this.sweep(nowMs, limits);
    const tally = this.tallyFor(`${sourceBucket(probe.source, limits)}|${normalizeDnsName(probe.imputedName)}|${probe.error}`, nowMs);
    if (nowMs - tally.windowStartMs >= limits.windowSeconds * MILLISECONDS_PER_SECOND) {
      tally.windowStartMs = nowMs;
      tally.given = 0;
      tally.excess = 0;
    }
    tally.recent = tally.recent.filter(at => nowMs - at < MILLISECONDS_PER_SECOND);
    const windowFull = tally.given >= limits.maximumResponsesPerWindow;
    const rate = probe.error ? limits.errorsPerSecond : limits.responsesPerSecond;
    if (!windowFull && tally.recent.length < rate) {
      tally.recent.push(nowMs);
      tally.given += 1;
      return 'send';
    }
    tally.excess += 1;
    if (windowFull) return 'drop';
    if (limits.truncateRate > 0 && tally.excess % limits.truncateRate === 0) {
      tally.given += 1;
      return 'truncate';
    }
    if (limits.leakRate > 0 && tally.excess % limits.leakRate === 0) {
      tally.given += 1;
      return 'leak';
    }
    return 'drop';
  }

  tracked(): number {
    return this.tallies.size;
  }

  reset(): void {
    this.tallies.clear();
    this.nextSweepAtMs = 0;
  }

  private tallyFor(key: string, nowMs: number): Tally {
    const known = this.tallies.get(key);
    const tally = known ?? { recent: [], windowStartMs: nowMs, given: 0, excess: 0, lastSeenMs: nowMs };
    tally.lastSeenMs = nowMs;
    this.tallies.delete(key);
    this.tallies.set(key, tally);
    if (this.tallies.size > this.capacity) this.tallies.delete(this.tallies.keys().next().value as string);
    return tally;
  }

  private sweep(nowMs: number, limits: RateLimits): void {
    if (nowMs < this.nextSweepAtMs) return;
    const windowMs = limits.windowSeconds * MILLISECONDS_PER_SECOND;
    for (const [key, tally] of this.tallies) {
      if (nowMs - tally.lastSeenMs < windowMs) break;
      this.tallies.delete(key);
    }
    this.nextSweepAtMs = nowMs + windowMs;
  }
}

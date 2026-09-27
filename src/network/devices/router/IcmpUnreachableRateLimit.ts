import { ICMP_UNREACH_FRAG_NEEDED } from '../../core/IcmpErrors';

export type UnreachableTimer = 'df' | 'general';

export const IOS_UNREACHABLE_INTERVAL_MS = 500;

export function unreachableTimerFor(code: number): UnreachableTimer {
  return code === ICMP_UNREACH_FRAG_NEEDED ? 'df' : 'general';
}

export class IcmpUnreachableRateLimit {
  private readonly intervals: Record<UnreachableTimer, number | null>;
  private readonly lastSent: Record<UnreachableTimer, number | null> = { df: null, general: null };

  constructor(private readonly defaultIntervalMs: number | null, private readonly now: () => number) {
    this.intervals = { df: defaultIntervalMs, general: defaultIntervalMs };
  }

  intervalMs(timer: UnreachableTimer): number | null {
    return this.intervals[timer];
  }

  setIntervalMs(timer: UnreachableTimer, intervalMs: number | null): void {
    this.intervals[timer] = intervalMs;
    this.lastSent[timer] = null;
  }

  admit(code: number): boolean {
    const timer = unreachableTimerFor(code);
    const interval = this.intervals[timer];
    if (interval === null) return true;
    const now = this.now();
    const last = this.lastSent[timer];
    if (last !== null && now - last < interval) return false;
    this.lastSent[timer] = now;
    return true;
  }

  runningConfigLines(): string[] {
    const lines: string[] = [];
    for (const [timer, keyword] of [['general', ''], ['df', ' df']] as const) {
      const interval = this.intervals[timer];
      if (interval === this.defaultIntervalMs) continue;
      lines.push(interval === null
        ? `no ip icmp rate-limit unreachable${keyword}`
        : `ip icmp rate-limit unreachable${keyword} ${interval}`);
    }
    return lines;
  }
}

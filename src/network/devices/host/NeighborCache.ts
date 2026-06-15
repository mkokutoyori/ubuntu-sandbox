import type { MACAddress } from '../../core/types';
import type { IScheduler, TimerHandle } from '../../../events/Scheduler';

export type NeighborState = 'incomplete' | 'reachable' | 'stale' | 'delay' | 'probe';

export interface NeighborCacheEntry {
  mac: MACAddress;
  iface: string;
  state: NeighborState;
  isRouter: boolean;
  timestamp: number;
}

export const NDP_REACHABLE_TIME_MS = 30_000;
export const NDP_DELAY_FIRST_PROBE_MS = 5_000;
export const NDP_RETRANS_TIMER_MS = 1_000;
export const NDP_MAX_UNICAST_SOLICIT = 3;
export const NDP_MAX_MULTICAST_SOLICIT = 3;

export interface NeighborCacheHooks {
  sendUnicastSolicit?: (ip: string, entry: NeighborCacheEntry) => void;
  onLearned?: (ip: string, entry: NeighborCacheEntry) => void;
  onUnreachable?: (ip: string) => void;
}

export class NeighborCache implements Iterable<[string, NeighborCacheEntry]> {
  private readonly entries = new Map<string, NeighborCacheEntry>();
  private readonly timers = new Map<string, TimerHandle>();

  constructor(
    private readonly scheduler: () => IScheduler,
    private readonly hooks: NeighborCacheHooks = {},
  ) {}

  get size(): number {
    return this.entries.size;
  }

  [Symbol.iterator](): IterableIterator<[string, NeighborCacheEntry]> {
    return this.entries[Symbol.iterator]();
  }

  get(ip: string): NeighborCacheEntry | undefined {
    const entry = this.entries.get(ip);
    if (!entry) return undefined;
    if (entry.state === 'reachable'
        && this.now() - entry.timestamp > NDP_REACHABLE_TIME_MS) {
      entry.state = 'stale';
    }
    return entry;
  }

  has(ip: string): boolean {
    return this.entries.has(ip);
  }

  snapshot(): Map<string, NeighborCacheEntry> {
    const copy = new Map<string, NeighborCacheEntry>();
    for (const [k, v] of this.entries) copy.set(k, { ...v });
    return copy;
  }

  internalMap(): Map<string, NeighborCacheEntry> {
    return this.entries;
  }

  learnFromSource(ip: string, mac: MACAddress, iface: string, isRouter: boolean): void {
    const existing = this.entries.get(ip);
    if (existing && existing.mac.equals(mac)) {
      existing.iface = iface;
      if (isRouter) existing.isRouter = true;
      return;
    }
    this.setEntry(ip, {
      mac, iface,
      state: 'stale',
      isRouter: isRouter || (existing?.isRouter ?? false),
      timestamp: this.now(),
    });
  }

  learnFromAdvertisement(
    ip: string,
    mac: MACAddress,
    iface: string,
    flags: { solicited: boolean; isRouter: boolean; override: boolean },
  ): void {
    const existing = this.entries.get(ip);
    if (existing && !flags.override && !existing.mac.equals(mac)) {
      if (existing.state === 'reachable') existing.state = 'stale';
      return;
    }
    this.setEntry(ip, {
      mac, iface,
      state: flags.solicited ? 'reachable' : 'stale',
      isRouter: flags.isRouter,
      timestamp: this.now(),
    });
  }

  confirmReachability(ip: string): void {
    const entry = this.entries.get(ip);
    if (!entry) return;
    entry.state = 'reachable';
    entry.timestamp = this.now();
    this.cancelTimer(ip);
  }

  markUsed(ip: string): NeighborCacheEntry | undefined {
    const entry = this.get(ip);
    if (!entry) return undefined;
    if (entry.state === 'stale') this.enterDelay(ip, entry);
    return entry;
  }

  setStatic(ip: string, entry: NeighborCacheEntry): void {
    this.setEntry(ip, entry);
  }

  remove(ip: string): boolean {
    this.cancelTimer(ip);
    return this.entries.delete(ip);
  }

  clear(): void {
    for (const ip of this.timers.keys()) this.cancelTimer(ip);
    this.entries.clear();
  }

  stop(): void {
    for (const handle of this.timers.values()) this.scheduler().clear(handle);
    this.timers.clear();
  }

  private enterDelay(ip: string, entry: NeighborCacheEntry): void {
    entry.state = 'delay';
    this.armTimer(ip, NDP_DELAY_FIRST_PROBE_MS, () => this.enterProbe(ip));
  }

  private enterProbe(ip: string): void {
    const entry = this.entries.get(ip);
    if (!entry || entry.state !== 'delay') return;
    entry.state = 'probe';
    this.probe(ip, 1);
  }

  private probe(ip: string, attempt: number): void {
    const entry = this.entries.get(ip);
    if (!entry || entry.state !== 'probe') return;
    if (attempt > NDP_MAX_UNICAST_SOLICIT) {
      this.remove(ip);
      this.hooks.onUnreachable?.(ip);
      return;
    }
    this.hooks.sendUnicastSolicit?.(ip, entry);
    this.armTimer(ip, NDP_RETRANS_TIMER_MS, () => this.probe(ip, attempt + 1));
  }

  private setEntry(ip: string, entry: NeighborCacheEntry): void {
    this.cancelTimer(ip);
    this.entries.set(ip, entry);
    this.hooks.onLearned?.(ip, entry);
  }

  private armTimer(ip: string, delayMs: number, fn: () => void): void {
    this.cancelTimer(ip);
    this.timers.set(ip, this.scheduler().setTimeout(() => {
      this.timers.delete(ip);
      fn();
    }, delayMs));
  }

  private cancelTimer(ip: string): void {
    const handle = this.timers.get(ip);
    if (handle !== undefined) {
      this.scheduler().clear(handle);
      this.timers.delete(ip);
    }
  }

  private now(): number {
    return this.scheduler().now();
  }
}

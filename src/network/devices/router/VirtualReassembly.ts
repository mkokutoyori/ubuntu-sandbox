import { simulationNowMs } from '@/network/core/SystemClock';
import type { IPv4Packet } from '@/network/core/types';
import { fragmentRole } from './FragmentRewriteMemory';

export interface VfrSettings {
  readonly maxReassemblies: number;
  readonly maxFragments: number;
  readonly timeoutSeconds: number;
  readonly dropFragments: boolean;
}

export const VFR_DEFAULTS: VfrSettings = Object.freeze({
  maxReassemblies: 16,
  maxFragments: 32,
  timeoutSeconds: 3,
  dropFragments: false,
});

export type VfrAlert = 'VFR-3-OVERLAP_FRAGMENT' | 'VFR-4_FRAG_TABLE_OVERFLOW' | 'VFR-4_TOO_MANY_FRAGMENTS';

export type VfrVerdict = { readonly pass: true } | { readonly pass: false; readonly alert?: VfrAlert };

export interface VfrSnapshot {
  readonly settings: VfrSettings;
  readonly currentReassemblies: number;
  readonly currentFragments: number;
  readonly totalReassemblies: number;
  readonly totalFailures: number;
}

interface Range { readonly start: number; readonly end: number }

interface Datagram {
  readonly iface: string;
  readonly startedAt: number;
  readonly ranges: Range[];
  fragments: number;
  finalEnd: number | null;
  refused: boolean;
}

interface Counters { total: number; failures: number }

export class VirtualReassembly {
  private readonly configured = new Map<string, VfrSettings>();
  private readonly featureCount = new Map<string, number>();
  private readonly datagrams = new Map<string, Datagram>();
  private readonly counters = new Map<string, Counters>();

  configure(iface: string, change: Partial<VfrSettings>): void {
    this.configured.set(iface, { ...(this.configured.get(iface) ?? VFR_DEFAULTS), ...change });
  }

  unconfigure(iface: string): void {
    this.configured.delete(iface);
    this.forget(iface);
  }

  retain(iface: string): void {
    this.featureCount.set(iface, (this.featureCount.get(iface) ?? 0) + 1);
  }

  release(iface: string): void {
    const remaining = (this.featureCount.get(iface) ?? 0) - 1;
    if (remaining > 0) this.featureCount.set(iface, remaining);
    else {
      this.featureCount.delete(iface);
      if (!this.configured.has(iface)) this.forget(iface);
    }
  }

  isEnabled(iface: string): boolean {
    return this.configured.has(iface) || (this.featureCount.get(iface) ?? 0) > 0;
  }

  isConfigured(iface: string): boolean {
    return this.configured.has(iface);
  }

  settings(iface: string): VfrSettings | null {
    if (!this.isEnabled(iface)) return null;
    return this.configured.get(iface) ?? VFR_DEFAULTS;
  }

  lifetimeMs(iface: string): number {
    return (this.settings(iface) ?? VFR_DEFAULTS).timeoutSeconds * 1000;
  }

  enabledInterfaces(): string[] {
    return [...new Set([...this.configured.keys(), ...this.featureCount.keys()])].sort();
  }

  observe(iface: string, packet: IPv4Packet): VfrVerdict {
    const settings = this.settings(iface);
    if (settings === null || fragmentRole(packet) === null) return { pass: true };
    if (settings.dropFragments) return { pass: false };
    this.expire(iface, settings);

    const key = `${iface}|${packet.sourceIP}|${packet.destinationIP}|${packet.protocol}|${packet.identification}`;
    let datagram = this.datagrams.get(key);
    if (datagram?.refused) return { pass: false };
    if (datagram === undefined) {
      if (this.activeIn(iface).length >= settings.maxReassemblies) {
        this.refuse(key, iface);
        return { pass: false, alert: 'VFR-4_FRAG_TABLE_OVERFLOW' };
      }
      datagram = { iface, startedAt: simulationNowMs(), ranges: [], fragments: 0, finalEnd: null, refused: false };
      this.datagrams.set(key, datagram);
    }

    const start = packet.fragmentOffset * 8;
    const range: Range = { start, end: start + packet.totalLength - packet.ihl * 4 };
    if (datagram.ranges.some((known) => range.start < known.end && known.start < range.end)) {
      this.refuse(key, iface);
      return { pass: false, alert: 'VFR-3-OVERLAP_FRAGMENT' };
    }
    if (datagram.fragments + 1 > settings.maxFragments) {
      this.refuse(key, iface);
      return { pass: false, alert: 'VFR-4_TOO_MANY_FRAGMENTS' };
    }
    datagram.ranges.push(range);
    datagram.fragments++;
    if ((packet.flags & 0b001) === 0) datagram.finalEnd = range.end;
    if (this.isComplete(datagram)) {
      this.datagrams.delete(key);
      this.countersOf(iface).total++;
    }
    return { pass: true };
  }

  snapshot(iface: string): VfrSnapshot | null {
    const settings = this.settings(iface);
    if (settings === null) return null;
    this.expire(iface, settings);
    const active = this.activeIn(iface);
    const counters = this.countersOf(iface);
    return {
      settings,
      currentReassemblies: active.length,
      currentFragments: active.reduce((sum, datagram) => sum + datagram.fragments, 0),
      totalReassemblies: counters.total,
      totalFailures: counters.failures,
    };
  }

  private isComplete(datagram: Datagram): boolean {
    if (datagram.finalEnd === null) return false;
    const ordered = [...datagram.ranges].sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const range of ordered) {
      if (range.start !== covered) return false;
      covered = range.end;
    }
    return covered === datagram.finalEnd;
  }

  private refuse(key: string, iface: string): void {
    const existing = this.datagrams.get(key);
    this.datagrams.set(key, {
      iface, startedAt: existing?.startedAt ?? simulationNowMs(), ranges: [], fragments: 0, finalEnd: null, refused: true,
    });
    this.countersOf(iface).failures++;
  }

  private expire(iface: string, settings: VfrSettings): void {
    const now = simulationNowMs();
    for (const [key, datagram] of this.datagrams) {
      if (datagram.iface !== iface || now - datagram.startedAt < settings.timeoutSeconds * 1000) continue;
      this.datagrams.delete(key);
      if (!datagram.refused) this.countersOf(iface).failures++;
    }
  }

  private activeIn(iface: string): Datagram[] {
    return [...this.datagrams.values()].filter((datagram) => datagram.iface === iface && !datagram.refused);
  }

  private forget(iface: string): void {
    for (const [key, datagram] of this.datagrams) if (datagram.iface === iface) this.datagrams.delete(key);
  }

  private countersOf(iface: string): Counters {
    let counters = this.counters.get(iface);
    if (counters === undefined) {
      counters = { total: 0, failures: 0 };
      this.counters.set(iface, counters);
    }
    return counters;
  }
}

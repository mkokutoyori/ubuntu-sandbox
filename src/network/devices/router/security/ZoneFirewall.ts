import type { IPv4Packet } from '../../../core/types';
import type { ClassMap, PolicyMap, PolicyMapClass, Zone, ZonePair } from './CiscoSecurityConfig';
import { simulationNowMs } from '@/network/core/SystemClock';
import { FlowTable, flowOf, protocolLabel, protocolMatches, IP_TCP, type FlowSession, type FlowView } from './FlowTable';

export const SELF_ZONE = 'self';
export const DEFAULT_ZONE = 'default';

export interface ZoneFirewallConfig {
  readonly zones: ReadonlyMap<string, Zone>;
  readonly zonePairs: ReadonlyMap<string, ZonePair>;
  readonly classMaps: ReadonlyMap<string, ClassMap>;
  readonly policyMaps: ReadonlyMap<string, PolicyMap>;
  zoneOfInterface(iface: string): string | undefined;
}

export interface ZoneFirewallPort {
  permits(inIface: string | null, outIface: string | null, packet: IPv4Packet,
    aclPermits: (name: string, packet: IPv4Packet) => boolean): ZoneVerdict;
}

export interface ZoneVerdict {
  readonly permit: boolean;
  readonly logLine?: string;
}

export type ZoneSession = FlowSession;

export interface ClassCounters {
  matchedPackets: number;
  matchedBytes: number;
  sessionsCreated: number;
  dropped: number;
  peakEstablished: number;
  lastSessionMs: number | null;
  resetMs: number | null;
  creationTimes: number[];
}

export class ZoneFirewall implements ZoneFirewallPort {
  private readonly flows = new FlowTable();
  private readonly counters = new Map<string, ClassCounters>();

  constructor(private readonly source: () => ZoneFirewallConfig) {}

  private get config(): ZoneFirewallConfig {
    return this.source();
  }

  private zoneOf(iface: string | null): string | null {
    if (iface === null) return SELF_ZONE;
    const member = this.config.zoneOfInterface(iface);
    if (member !== undefined) return member;
    return this.config.zones.has(DEFAULT_ZONE) ? DEFAULT_ZONE : null;
  }

  private anyZoneConfigured(): boolean {
    return this.config.zones.size > 0 || this.config.zonePairs.size > 0;
  }

  private classMatches(cls: PolicyMapClass, packet: IPv4Packet, flow: FlowView,
    aclPermits: (name: string, packet: IPv4Packet) => boolean): boolean {
    if (cls.kind === 'class-default') return true;
    const map = this.config.classMaps.get(cls.className);
    if (!map || map.matches.length === 0) return false;
    const test = (match: ClassMap['matches'][number]): boolean => {
      if (match.kind === 'any') return true;
      if (match.kind === 'access-group-name' || match.kind === 'access-group-num') {
        return match.value !== undefined && aclPermits(match.value, packet);
      }
      return protocolMatches(match.value ?? '', flow);
    };
    return map.matchAll ? map.matches.every(test) : map.matches.some(test);
  }

  counterOf(zonePair: string, className: string): ClassCounters {
    const key = `${zonePair}|${className}`;
    let value = this.counters.get(key);
    if (!value) {
      value = {
        matchedPackets: 0, matchedBytes: 0, sessionsCreated: 0, dropped: 0,
        peakEstablished: 0, lastSessionMs: null, resetMs: null, creationTimes: [],
      };
      this.counters.set(key, value);
    }
    return value;
  }

  sessionList(zonePair?: string): ZoneSession[] {
    this.flows.expire(simulationNowMs());
    return this.flows.list(zonePair);
  }

  clearSessions(zonePair?: string): void {
    this.flows.clear(zonePair);
  }

  clearCounters(zonePair?: string): void {
    const now = simulationNowMs();
    for (const key of [...this.counters.keys()]) {
      if (zonePair !== undefined && !key.startsWith(`${zonePair}|`)) continue;
      this.counters.delete(key);
      const fresh = this.counterOf(key.split('|')[0], key.slice(key.indexOf('|') + 1));
      fresh.resetMs = now;
    }
  }

  creationRate(counter: ClassCounters): number {
    const now = simulationNowMs();
    counter.creationTimes = counter.creationTimes.filter((t) => now - t < 60_000);
    return counter.creationTimes.length;
  }

  permits(inIface: string | null, outIface: string | null, packet: IPv4Packet,
    aclPermits: (name: string, packet: IPv4Packet) => boolean): ZoneVerdict {
    if (!this.anyZoneConfigured()) return { permit: true };
    const source = this.zoneOf(inIface);
    const destination = this.zoneOf(outIface);
    const toOrFromSelf = inIface === null || outIface === null;
    if (source === null && destination === null) return { permit: true };
    if (!toOrFromSelf && source === destination) return { permit: true };

    const now = simulationNowMs();
    const flow = flowOf(packet);
    if (this.flows.observe(flow, now)) return { permit: true };

    if (source === null || destination === null) {
      return toOrFromSelf ? { permit: true } : { permit: false };
    }
    const pair = [...this.config.zonePairs.values()].find((candidate) =>
      candidate.source === source && candidate.destination === destination);
    if (!pair) return toOrFromSelf ? { permit: true } : { permit: false };
    const policy = pair.servicePolicy ? this.config.policyMaps.get(pair.servicePolicy) : undefined;
    if (!policy) return { permit: false };

    for (const cls of policy.classes) {
      if (!this.classMatches(cls, packet, flow, aclPermits)) continue;
      const counter = this.counterOf(pair.name, cls.className);
      counter.matchedPackets += 1;
      counter.matchedBytes += flow.bytes;
      const action = cls.actions.find((a) => a.kind === 'inspect' || a.kind === 'pass' || a.kind === 'drop');
      if (action?.kind === 'inspect') {
        if (flow.protocol === IP_TCP && !flow.synOnly) {
          counter.dropped += 1;
          return { permit: false };
        }
        counter.sessionsCreated += 1;
        counter.lastSessionMs = now;
        counter.creationTimes.push(now);
        this.flows.create(flow, pair.name, cls.className, now);
        const established = this.flows.list(pair.name).filter((x) => x.label === cls.className).length;
        counter.peakEstablished = Math.max(counter.peakEstablished, established);
        return { permit: true };
      }
      if (action?.kind === 'pass') return { permit: true };
      counter.dropped += 1;
      const logged = action?.kind === 'drop' && action.args.includes('log');
      return {
        permit: false,
        logLine: logged
          ? `Dropping ${protocolLabel(flow.protocol)} session ${flow.source}:${flow.sourcePort} ${flow.destination}:${flow.destinationPort} due to  Policy match failure`
          : undefined,
      };
    }
    return { permit: false };
  }
}

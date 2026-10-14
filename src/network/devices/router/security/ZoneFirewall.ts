import type { IPv4Packet } from '../../../core/types';
import type { ClassMap, PolicyMap, PolicyMapClass, Zone, ZonePair } from './CiscoSecurityConfig';
import { simulationNowMs } from '@/network/core/SystemClock';

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

export interface ZoneSession {
  readonly id: number;
  readonly zonePair: string;
  readonly className: string;
  readonly protocol: number;
  readonly initiator: string;
  readonly initiatorPort: number;
  readonly responder: string;
  readonly responderPort: number;
  readonly createdMs: number;
  lastHeardMs: number;
  initiatorBytes: number;
  responderBytes: number;
  state: 'SIS_OPEN' | 'SIS_OPENING' | 'SIS_CLOSING';
}

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

const IP_ICMP = 1;
const IP_TCP = 6;
const IP_UDP = 17;

const IDLE_SECONDS: Readonly<Record<number, number>> = { [IP_TCP]: 3600, [IP_UDP]: 30, [IP_ICMP]: 10 };

interface ProtocolDefinition {
  readonly protocol: number;
  readonly ports?: readonly number[];
}

const PROTOCOLS: Readonly<Record<string, readonly ProtocolDefinition[]>> = {
  tcp: [{ protocol: IP_TCP }],
  udp: [{ protocol: IP_UDP }],
  icmp: [{ protocol: IP_ICMP }],
  ftp: [{ protocol: IP_TCP, ports: [21] }],
  ssh: [{ protocol: IP_TCP, ports: [22] }],
  telnet: [{ protocol: IP_TCP, ports: [23] }],
  smtp: [{ protocol: IP_TCP, ports: [25] }],
  dns: [{ protocol: IP_UDP, ports: [53] }, { protocol: IP_TCP, ports: [53] }],
  tftp: [{ protocol: IP_UDP, ports: [69] }],
  http: [{ protocol: IP_TCP, ports: [80] }],
  pop3: [{ protocol: IP_TCP, ports: [110] }],
  ntp: [{ protocol: IP_UDP, ports: [123] }],
  imap: [{ protocol: IP_TCP, ports: [143] }],
  snmp: [{ protocol: IP_UDP, ports: [161, 162] }],
  ldap: [{ protocol: IP_TCP, ports: [389] }],
  https: [{ protocol: IP_TCP, ports: [443] }],
  syslog: [{ protocol: IP_UDP, ports: [514] }],
  isakmp: [{ protocol: IP_UDP, ports: [500] }],
};

interface FlowView {
  readonly protocol: number;
  readonly source: string;
  readonly destination: string;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly synOnly: boolean;
  readonly closing: boolean;
  readonly bytes: number;
}

function flowOf(packet: IPv4Packet): FlowView {
  const transport = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number; id?: number;
    flags?: { syn: boolean; ack: boolean; fin: boolean; rst: boolean };
  } | undefined;
  const icmp = packet.protocol === IP_ICMP;
  return {
    protocol: packet.protocol,
    source: packet.sourceIP.toString(),
    destination: packet.destinationIP.toString(),
    sourcePort: icmp ? (transport?.id ?? 0) : (transport?.sourcePort ?? 0),
    destinationPort: icmp ? (transport?.id ?? 0) : (transport?.destinationPort ?? 0),
    synOnly: transport?.type === 'tcp' && transport.flags?.syn === true && transport.flags.ack !== true,
    closing: transport?.type === 'tcp' && (transport.flags?.rst === true || transport.flags?.fin === true),
    bytes: packet.totalLength,
  };
}

function flowKey(f: { protocol: number; source: string; sourcePort: number; destination: string; destinationPort: number }): string {
  return `${f.protocol}|${f.source}|${f.sourcePort}|${f.destination}|${f.destinationPort}`;
}

export class ZoneFirewall implements ZoneFirewallPort {
  private readonly sessions = new Map<string, ZoneSession>();
  private readonly counters = new Map<string, ClassCounters>();
  private lastSessionId = 0;

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

  private expire(now: number): void {
    for (const [key, session] of this.sessions) {
      const idle = IDLE_SECONDS[session.protocol] ?? 30;
      if (now - session.lastHeardMs >= idle * 1000) this.sessions.delete(key);
    }
  }

  private findSession(flow: FlowView): { session: ZoneSession; forward: boolean } | null {
    const forward = this.sessions.get(flowKey(flow));
    if (forward) return { session: forward, forward: true };
    const reverse = this.sessions.get(flowKey({
      protocol: flow.protocol, source: flow.destination, sourcePort: flow.destinationPort,
      destination: flow.source, destinationPort: flow.sourcePort,
    }));
    return reverse ? { session: reverse, forward: false } : null;
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
      const definitions = PROTOCOLS[(match.value ?? '').toLowerCase()];
      if (!definitions) return false;
      return definitions.some((definition) => definition.protocol === flow.protocol
        && (definition.ports === undefined || definition.ports.includes(flow.destinationPort)
          || definition.ports.includes(flow.sourcePort)));
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
    this.expire(simulationNowMs());
    return [...this.sessions.values()].filter((s) => zonePair === undefined || s.zonePair === zonePair);
  }

  clearSessions(zonePair?: string): void {
    for (const [key, session] of this.sessions) if (zonePair === undefined || session.zonePair === zonePair) this.sessions.delete(key);
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
    this.expire(now);
    const flow = flowOf(packet);
    const known = this.findSession(flow);
    if (known) {
      known.session.lastHeardMs = now;
      if (known.forward) known.session.initiatorBytes += flow.bytes;
      else {
        known.session.responderBytes += flow.bytes;
        if (known.session.state === 'SIS_OPENING') known.session.state = 'SIS_OPEN';
      }
      if (flow.closing) this.sessions.delete(flowKey({
        protocol: known.session.protocol, source: known.session.initiator, sourcePort: known.session.initiatorPort,
        destination: known.session.responder, destinationPort: known.session.responderPort,
      }));
      return { permit: true };
    }

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
        this.sessions.set(flowKey(flow), {
          id: ++this.lastSessionId, zonePair: pair.name, className: cls.className, protocol: flow.protocol,
          initiator: flow.source, initiatorPort: flow.sourcePort,
          responder: flow.destination, responderPort: flow.destinationPort,
          createdMs: now, lastHeardMs: now, initiatorBytes: flow.bytes, responderBytes: 0, state: 'SIS_OPENING',
        });
        const established = [...this.sessions.values()].filter((x) => x.zonePair === pair.name && x.className === cls.className).length;
        counter.peakEstablished = Math.max(counter.peakEstablished, established);
        return { permit: true };
      }
      if (action?.kind === 'pass') return { permit: true };
      counter.dropped += 1;
      const logged = action?.kind === 'drop' && action.args.includes('log');
      return {
        permit: false,
        logLine: logged
          ? `Dropping ${flow.protocol === IP_TCP ? 'tcp' : flow.protocol === IP_UDP ? 'udp' : flow.protocol === IP_ICMP ? 'icmp' : `ip ${flow.protocol}`} session ${flow.source}:${flow.sourcePort} ${flow.destination}:${flow.destinationPort} due to  Policy match failure`
          : undefined,
      };
    }
    return { permit: false };
  }
}

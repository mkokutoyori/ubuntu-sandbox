import type { IPv4Packet } from '../../../core/types';

export const IP_ICMP = 1;
export const IP_TCP = 6;
export const IP_UDP = 17;

export interface ProtocolDefinition {
  readonly protocol: number;
  readonly ports?: readonly number[];
}

export const INSPECT_PROTOCOLS: Readonly<Record<string, readonly ProtocolDefinition[]>> = {
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

export interface FlowView {
  readonly protocol: number;
  readonly source: string;
  readonly destination: string;
  readonly sourcePort: number;
  readonly destinationPort: number;
  readonly synOnly: boolean;
  readonly synAck: boolean;
  readonly finOrRst: boolean;
  readonly rst: boolean;
  readonly bytes: number;
}

export function flowOf(packet: IPv4Packet): FlowView {
  const transport = packet.payload as {
    type?: string; sourcePort?: number; destinationPort?: number; id?: number;
    flags?: { syn: boolean; ack: boolean; fin: boolean; rst: boolean };
  } | undefined;
  const icmp = packet.protocol === IP_ICMP;
  const flags = transport?.type === 'tcp' ? transport.flags : undefined;
  return {
    protocol: packet.protocol,
    source: packet.sourceIP.toString(),
    destination: packet.destinationIP.toString(),
    sourcePort: icmp ? (transport?.id ?? 0) : (transport?.sourcePort ?? 0),
    destinationPort: icmp ? (transport?.id ?? 0) : (transport?.destinationPort ?? 0),
    synOnly: flags?.syn === true && flags.ack !== true,
    synAck: flags?.syn === true && flags.ack === true,
    finOrRst: flags?.fin === true || flags?.rst === true,
    rst: flags?.rst === true,
    bytes: packet.totalLength,
  };
}

export function protocolMatches(name: string, flow: FlowView): boolean {
  const definitions = INSPECT_PROTOCOLS[name.toLowerCase()];
  if (!definitions) return false;
  return definitions.some((definition) => definition.protocol === flow.protocol
    && (definition.ports === undefined || definition.ports.includes(flow.destinationPort)
      || definition.ports.includes(flow.sourcePort)));
}

export function protocolLabel(protocol: number): string {
  return protocol === IP_TCP ? 'tcp' : protocol === IP_UDP ? 'udp' : protocol === IP_ICMP ? 'icmp' : `ip-${protocol}`;
}

export type FlowState = 'SIS_OPEN' | 'SIS_OPENING' | 'SIS_CLOSING';

export interface FlowSession {
  readonly id: number;
  readonly owner: string;
  readonly label: string;
  readonly protocol: number;
  readonly initiator: string;
  readonly initiatorPort: number;
  readonly responder: string;
  readonly responderPort: number;
  readonly createdMs: number;
  lastHeardMs: number;
  initiatorBytes: number;
  responderBytes: number;
  state: FlowState;
  readonly idleOverrideSec?: number;
}

export interface FlowTimeouts {
  readonly tcpIdleSec: number;
  readonly tcpSynwaitSec: number;
  readonly tcpFinwaitSec: number;
  readonly udpIdleSec: number;
  readonly icmpIdleSec: number;
  readonly dnsSec: number;
}

export const DEFAULT_FLOW_TIMEOUTS: FlowTimeouts = Object.freeze({
  tcpIdleSec: 3600, tcpSynwaitSec: 30, tcpFinwaitSec: 5, udpIdleSec: 30, icmpIdleSec: 10, dnsSec: 5,
});

export type FlowEndReason = 'idle' | 'closed' | 'reset' | 'cleared' | 'evicted';

function keyOf(f: { protocol: number; source: string; sourcePort: number; destination: string; destinationPort: number }): string {
  return `${f.protocol}|${f.source}|${f.sourcePort}|${f.destination}|${f.destinationPort}`;
}

export class FlowTable {
  private readonly sessions = new Map<string, FlowSession>();
  private lastId = 0;

  constructor(
    private readonly timeouts: () => FlowTimeouts = () => DEFAULT_FLOW_TIMEOUTS,
    private readonly onEnd: (session: FlowSession, reason: FlowEndReason) => void = () => {},
  ) {}

  private keyOfSession(session: FlowSession): string {
    return keyOf({
      protocol: session.protocol, source: session.initiator, sourcePort: session.initiatorPort,
      destination: session.responder, destinationPort: session.responderPort,
    });
  }

  private lifetimeSec(session: FlowSession): number {
    if (session.idleOverrideSec !== undefined && session.state === 'SIS_OPEN') return session.idleOverrideSec;
    const t = this.timeouts();
    if (session.protocol === IP_TCP) {
      return session.state === 'SIS_OPENING' ? t.tcpSynwaitSec : session.state === 'SIS_CLOSING' ? t.tcpFinwaitSec : t.tcpIdleSec;
    }
    if (session.protocol === IP_UDP) {
      return session.responderPort === 53 || session.initiatorPort === 53 ? t.dnsSec : t.udpIdleSec;
    }
    return session.protocol === IP_ICMP ? t.icmpIdleSec : t.udpIdleSec;
  }

  private end(session: FlowSession, reason: FlowEndReason): void {
    if (this.sessions.delete(this.keyOfSession(session))) this.onEnd(session, reason);
  }

  expire(now: number): void {
    for (const session of [...this.sessions.values()]) {
      if (now - session.lastHeardMs >= this.lifetimeSec(session) * 1000) this.end(session, 'idle');
    }
  }

  lookup(flow: FlowView): { session: FlowSession; forward: boolean } | null {
    const forward = this.sessions.get(keyOf(flow));
    if (forward) return { session: forward, forward: true };
    const reverse = this.sessions.get(keyOf({
      protocol: flow.protocol, source: flow.destination, sourcePort: flow.destinationPort,
      destination: flow.source, destinationPort: flow.sourcePort,
    }));
    return reverse ? { session: reverse, forward: false } : null;
  }

  observe(flow: FlowView, now: number): FlowSession | null {
    this.expire(now);
    const known = this.lookup(flow);
    if (!known) return null;
    const { session, forward } = known;
    session.lastHeardMs = now;
    if (forward) session.initiatorBytes += flow.bytes;
    else {
      session.responderBytes += flow.bytes;
      if (session.state === 'SIS_OPENING' && (flow.protocol !== IP_TCP || flow.synAck)) session.state = 'SIS_OPEN';
    }
    if (flow.protocol === IP_TCP) {
      if (flow.rst) this.end(session, 'reset');
      else if (flow.finOrRst) session.state = 'SIS_CLOSING';
    }
    return session;
  }

  create(flow: FlowView, owner: string, label: string, now: number, idleOverrideSec?: number): FlowSession {
    const session: FlowSession = {
      id: ++this.lastId, owner, label, protocol: flow.protocol,
      initiator: flow.source, initiatorPort: flow.sourcePort,
      responder: flow.destination, responderPort: flow.destinationPort,
      createdMs: now, lastHeardMs: now, initiatorBytes: flow.bytes, responderBytes: 0,
      state: 'SIS_OPENING', idleOverrideSec,
    };
    this.sessions.set(this.keyOfSession(session), session);
    return session;
  }

  list(owner?: string): FlowSession[] {
    return [...this.sessions.values()].filter((s) => owner === undefined || s.owner === owner);
  }

  remove(session: FlowSession, reason: FlowEndReason): void {
    this.end(session, reason);
  }

  clear(owner?: string): void {
    for (const session of this.list(owner)) this.end(session, 'cleared');
  }
}

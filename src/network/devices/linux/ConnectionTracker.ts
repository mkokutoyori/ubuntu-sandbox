import { simulationNowMs } from '@/network/core/SystemClock';

import { IP_PROTO_ICMP, IP_PROTO_ICMPV6, IP_PROTO_TCP, IP_PROTO_UDP, IP_PROTO_UDPLITE, IPAddress, PORT_BEARING_PROTOCOLS } from '../../core/types';
import { IP_PROTO_GRE } from '../../gre/types';
import { uniqueTuple, type NatManipulation, type NatWorld } from './NatMapping';
import type { NatRange } from './NatRange';

export type ConnectionState = 'INVALID' | 'UNTRACKED' | 'NEW' | 'RELATED' | 'ESTABLISHED';

export type TcpConntrackState =
  | 'NONE' | 'SYN_SENT' | 'SYN_RECV' | 'ESTABLISHED' | 'FIN_WAIT' | 'CLOSE_WAIT' | 'LAST_ACK'
  | 'TIME_WAIT' | 'CLOSE' | 'SYN_SENT2';

export interface ConnectionTuple {
  readonly protocol: number;
  readonly srcIP: string;
  readonly srcPort: number;
  readonly dstIP: string;
  readonly dstPort: number;
  readonly icmpType?: number;
  readonly icmpId?: number;
  readonly icmpCode?: number;
}

export interface TrackedPacket extends ConnectionTuple {
  readonly related?: ConnectionTuple;
  readonly tcpFlags?: number;
}

export interface ConnectionStatistics {
  found: number;
  invalid: number;
  insert: number;
  insert_failed: number;
  drop: number;
}

export interface NatTranslation {
  readonly side: NatManipulation;
  readonly address: string;
  readonly key: number | null;
}

export interface ErrorTranslation {
  readonly inner: NatTranslation;
  readonly outer: NatTranslation;
}

export interface FlowView {
  readonly original: ConnectionTuple;
  readonly reply: ConnectionTuple;
  readonly remainingMs: number;
  readonly replied: boolean;
  readonly assured: boolean;
  readonly tcpState: TcpConntrackState | null;
  readonly mark: number;
  readonly natSource: boolean;
  readonly natDestination: boolean;
  readonly masqueradeInterface: string | null;
}

type Direction = 'original' | 'reply';

type TcpIndex = 'syn' | 'synack' | 'fin' | 'ack' | 'rst' | 'none';

type TcpCell = TcpConntrackState | 'INVALID' | 'IGNORE';

interface Flow {
  readonly original: ConnectionTuple;
  reply: ConnectionTuple;
  snat: boolean;
  dnat: boolean;
  readonly natDone: { source: boolean; destination: boolean };
  readonly createdAt: number;
  expiresAt: number;
  seenReply: boolean;
  assured: boolean;
  tcpState: TcpConntrackState | null;
  mark: number;
  masqueradeInterface: string | null;
  simultaneousOpen: boolean;
  closeInitiated: boolean;
  lastIndex: TcpIndex | null;
  lastDirection: Direction | null;
}

interface Hit {
  readonly flow: Flow;
  readonly direction: Direction;
}

export interface TrackedEntry {
  readonly state: ConnectionState;
  readonly hit: Hit | null;
  readonly pending: Flow | null;
  readonly commit: () => void;
  confirmed: boolean;
}

function entry(state: ConnectionState, parts: { hit?: Hit; pending?: Flow; commit?: () => void } = {}): TrackedEntry {
  return { state, hit: parts.hit ?? null, pending: parts.pending ?? null, commit: parts.commit ?? (() => undefined), confirmed: false };
}

const SECOND_MS = 1000;
const STREAM_AFTER_MS = 2 * SECOND_MS;
const PURGE_INTERVAL_MS = SECOND_MS;
const ICMP_TIMEOUT_MS = 30 * SECOND_MS;
const UDP_UNREPLIED_TIMEOUT_MS = 30 * SECOND_MS;
const UDP_REPLIED_TIMEOUT_MS = 120 * SECOND_MS;
const GRE_UNREPLIED_TIMEOUT_MS = 30 * SECOND_MS;
const GRE_REPLIED_TIMEOUT_MS = 180 * SECOND_MS;
const GENERIC_TIMEOUT_MS = 600 * SECOND_MS;
const DATAGRAM_PROTOCOLS: ReadonlySet<number> = new Set([IP_PROTO_UDP, IP_PROTO_UDPLITE]);

const TCP_TIMEOUT_MS: Readonly<Record<TcpConntrackState, number>> = {
  NONE: 0,
  SYN_SENT: 120 * SECOND_MS,
  SYN_RECV: 60 * SECOND_MS,
  ESTABLISHED: 5 * 24 * 3600 * SECOND_MS,
  FIN_WAIT: 120 * SECOND_MS,
  CLOSE_WAIT: 60 * SECOND_MS,
  LAST_ACK: 30 * SECOND_MS,
  TIME_WAIT: 120 * SECOND_MS,
  CLOSE: 10 * SECOND_MS,
  SYN_SENT2: 120 * SECOND_MS,
};

const TCP_UNACKNOWLEDGED_TIMEOUT_MS = 5 * 60 * SECOND_MS;

const TCP_STATE_COLUMNS: readonly TcpConntrackState[] = [
  'NONE', 'SYN_SENT', 'SYN_RECV', 'ESTABLISHED', 'FIN_WAIT', 'CLOSE_WAIT', 'LAST_ACK', 'TIME_WAIT', 'CLOSE', 'SYN_SENT2',
];

const TCP_CELL_OF_CODE: Readonly<Record<string, TcpCell>> = {
  NO: 'NONE', SS: 'SYN_SENT', SR: 'SYN_RECV', ES: 'ESTABLISHED', FW: 'FIN_WAIT', CW: 'CLOSE_WAIT',
  LA: 'LAST_ACK', TW: 'TIME_WAIT', CL: 'CLOSE', S2: 'SYN_SENT2', IV: 'INVALID', IG: 'IGNORE',
};

function tcpRow(codes: string): readonly TcpCell[] {
  return codes.split(' ').map((code) => TCP_CELL_OF_CODE[code]);
}

const TCP_TRANSITIONS: Readonly<Record<Direction, Readonly<Record<TcpIndex, readonly TcpCell[]>>>> = {
  original: {
    syn: tcpRow('SS SS IG IG IG IG IG SS SS S2'),
    synack: tcpRow('IV IV SR IV IV IV IV IV IV SR'),
    fin: tcpRow('IV IV FW FW LA LA LA TW CL IV'),
    ack: tcpRow('ES IV ES ES CW CW TW TW CL IV'),
    rst: tcpRow('IV CL CL CL CL CL CL CL CL CL'),
    none: tcpRow('IV IV IV IV IV IV IV IV IV IV'),
  },
  reply: {
    syn: tcpRow('IV S2 IV IV IV IV IV SS IV S2'),
    synack: tcpRow('IV SR IG IG IG IG IG IG IG SR'),
    fin: tcpRow('IV IV FW FW LA LA LA TW CL IV'),
    ack: tcpRow('IV IG SR ES CW CW TW TW CL IG'),
    rst: tcpRow('IV CL CL CL CL CL CL CL CL CL'),
    none: tcpRow('IV IV IV IV IV IV IV IV IV IV'),
  },
};

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;
const TCP_URG = 0x20;
const TCP_ECE = 0x40;
const TCP_CWR = 0x80;

const TCP_VALID_FLAGS: ReadonlySet<number> = new Set([
  TCP_SYN, TCP_SYN | TCP_URG, TCP_SYN | TCP_ACK, TCP_RST, TCP_RST | TCP_ACK,
  TCP_FIN | TCP_ACK, TCP_FIN | TCP_ACK | TCP_URG, TCP_ACK, TCP_ACK | TCP_URG,
]);

const ICMPV4_PEER_TYPE: Readonly<Record<number, number>> = { 0: 8, 8: 0, 13: 14, 14: 13, 15: 16, 16: 15, 17: 18, 18: 17 };
const ICMPV6_PEER_TYPE: Readonly<Record<number, number>> = { 128: 129, 129: 128, 139: 140, 140: 139 };
const ICMPV4_REQUEST_TYPES: ReadonlySet<number> = new Set([8, 13, 15, 17]);
const ICMPV6_REQUEST_TYPES: ReadonlySet<number> = new Set([128, 139]);
const ICMPV6_UNTRACKED_TYPES: ReadonlySet<number> = new Set([130, 131, 132, 133, 134, 135, 136, 143]);

function tcpIndexOf(flags: number): TcpIndex {
  if ((flags & TCP_RST) !== 0) return 'rst';
  if ((flags & TCP_SYN) !== 0) return (flags & TCP_ACK) !== 0 ? 'synack' : 'syn';
  if ((flags & TCP_FIN) !== 0) return 'fin';
  if ((flags & TCP_ACK) !== 0) return 'ack';
  return 'none';
}

function viewOf(flow: Flow, now: number): FlowView {
  return {
    original: flow.original, reply: flow.reply, remainingMs: flow.expiresAt - now, replied: flow.seenReply,
    assured: flow.assured, tcpState: flow.tcpState, mark: flow.mark, natSource: flow.snat, natDestination: flow.dnat,
    masqueradeInterface: flow.masqueradeInterface,
  };
}

function keyOf(tuple: ConnectionTuple): string {
  return `${tuple.protocol}|${tuple.srcIP}|${tuple.srcPort}|${tuple.dstIP}|${tuple.dstPort}|${tuple.icmpType ?? ''}|${tuple.icmpId ?? ''}`;
}

export function connectionTupleOf(packet: ConnectionTuple): ConnectionTuple {
  return {
    protocol: packet.protocol, srcIP: packet.srcIP, srcPort: packet.srcPort, dstIP: packet.dstIP, dstPort: packet.dstPort,
    ...(packet.icmpType === undefined ? {} : { icmpType: packet.icmpType }),
    ...(packet.icmpId === undefined ? {} : { icmpId: packet.icmpId }),
    ...(packet.icmpCode === undefined ? {} : { icmpCode: packet.icmpCode }),
  };
}

export class ConnectionTracker {
  private readonly index = new Map<string, Hit>();
  private purgedAt = 0;
  readonly statistics: ConnectionStatistics = { found: 0, invalid: 0, insert: 0, insert_failed: 0, drop: 0 };
  private randomState = 0x9e3779b9;

  constructor(private readonly family: 4 | 6) {}

  classify(packet: TrackedPacket): ConnectionState {
    return this.evaluate(packet).state;
  }

  enter(packet: TrackedPacket): TrackedEntry {
    const tracked = this.evaluate(packet);
    if (tracked.state === 'INVALID') this.statistics.invalid++;
    else if (tracked.hit !== null) this.statistics.found++;
    tracked.commit();
    return tracked;
  }

  confirm(tracked: TrackedEntry): boolean {
    if (tracked.pending === null || tracked.state !== 'NEW' || tracked.confirmed) return true;
    const flow = tracked.pending;
    const now = simulationNowMs();
    const clash = this.index.get(keyOf(flow.reply));
    if (clash !== undefined && clash.flow !== flow && keyOf(flow.reply) !== keyOf(flow.original)) {
      if (clash.flow.expiresAt > now) {
        this.statistics.insert_failed++;
        return false;
      }
      this.remove(clash.flow);
    }
    tracked.confirmed = true;
    this.index.set(keyOf(flow.original), { flow, direction: 'original' });
    if (keyOf(flow.reply) !== keyOf(flow.original)) this.index.set(keyOf(flow.reply), { flow, direction: 'reply' });
    this.statistics.insert++;
    if (now - this.purgedAt >= PURGE_INTERVAL_MS) this.purge(now);
    return true;
  }

  initialized(tracked: TrackedEntry, manipulation: NatManipulation): boolean {
    const flow = this.flowOf(tracked);
    return flow === null || flow.natDone[manipulation];
  }

  bind(tracked: TrackedEntry, range: NatRange, manipulation: NatManipulation): void {
    const flow = this.flowOf(tracked);
    if (flow === null || flow.natDone[manipulation] || this.family !== 4) return;
    flow.natDone[manipulation] = true;
    const current = this.reverseOf(flow.reply);
    if (current === null) return;
    const next = uniqueTuple(current, range, manipulation, this.natWorld(flow));
    const reply = this.reverseOf(next);
    if (reply === null || keyOf(reply) === keyOf(flow.reply)) return;
    this.alterReply(flow, reply);
    if (manipulation === 'source') flow.snat = true;
    else flow.dnat = true;
  }

  bindUnchanged(tracked: TrackedEntry, manipulation: NatManipulation): void {
    const flow = this.flowOf(tracked);
    if (flow === null || flow.natDone[manipulation]) return;
    const pinned = manipulation === 'source' ? flow.reply.dstIP : flow.reply.srcIP;
    this.bind(tracked, {
      addresses: { min: new IPAddress(pinned), max: new IPAddress(pinned) },
      ports: null, random: false, randomFully: false, persistent: false,
    }, manipulation);
  }

  masquerade(tracked: TrackedEntry, iface: string): void {
    const flow = this.flowOf(tracked);
    if (flow !== null) flow.masqueradeInterface = iface;
  }

  leavesByAnotherInterface(tracked: TrackedEntry, iface: string): boolean {
    const flow = this.flowOf(tracked);
    return flow !== null && flow.masqueradeInterface !== null && flow.masqueradeInterface !== iface
      && tracked.hit?.direction !== 'reply';
  }

  kill(tracked: TrackedEntry): void {
    const flow = this.flowOf(tracked);
    if (flow !== null) this.remove(flow);
  }

  translation(tracked: TrackedEntry, manipulation: NatManipulation): NatTranslation | null {
    const flow = this.flowOf(tracked);
    if (flow === null) return null;
    const direction = tracked.hit?.direction ?? 'original';
    const translated = (direction === 'original') === (manipulation === 'source') ? flow.snat : flow.dnat;
    if (!translated) return null;
    const other = direction === 'original' ? flow.reply : flow.original;
    const icmp = other.protocol === IP_PROTO_ICMP || other.protocol === IP_PROTO_ICMPV6;
    const address = manipulation === 'source' ? other.dstIP : other.srcIP;
    const port = manipulation === 'source' ? other.dstPort : other.srcPort;
    return { side: manipulation, address, key: icmp ? other.icmpId ?? null : PORT_BEARING_PROTOCOLS.has(other.protocol) ? port : null };
  }

  errorTranslation(tracked: TrackedEntry, manipulation: NatManipulation): ErrorTranslation | null {
    if (tracked.state !== 'RELATED' || tracked.hit === null) return null;
    const { flow, direction } = tracked.hit;
    const needed = (direction === 'original') === (manipulation === 'source') ? flow.snat : flow.dnat;
    if (!needed) return null;
    const opposite = direction === 'original' ? flow.reply : flow.original;
    const innerSide: NatManipulation = manipulation === 'source' ? 'destination' : 'source';
    const icmp = opposite.protocol === IP_PROTO_ICMP || opposite.protocol === IP_PROTO_ICMPV6;
    const port = innerSide === 'source' ? opposite.srcPort : opposite.dstPort;
    return {
      inner: {
        side: innerSide,
        address: innerSide === 'source' ? opposite.srcIP : opposite.dstIP,
        key: icmp ? opposite.icmpId ?? null : PORT_BEARING_PROTOCOLS.has(opposite.protocol) ? port : null,
      },
      outer: { side: manipulation, address: manipulation === 'source' ? opposite.dstIP : opposite.srcIP, key: null },
    };
  }

  flows(): readonly FlowView[] {
    const now = simulationNowMs();
    return this.liveFlows(now).map((flow) => viewOf(flow, now));
  }

  delete(matches: (view: FlowView) => boolean): readonly FlowView[] {
    const now = simulationNowMs();
    const doomed = this.liveFlows(now).filter((flow) => matches(viewOf(flow, now)));
    for (const flow of doomed) this.remove(flow);
    return doomed.map((flow) => viewOf(flow, now));
  }

  flush(): number {
    const flows = new Set<Flow>();
    for (const { flow } of this.index.values()) flows.add(flow);
    this.index.clear();
    return flows.size;
  }

  private evaluate(packet: TrackedPacket): TrackedEntry {
    if (packet.related !== undefined) return this.evaluateError(packet, packet.related);

    const icmp = packet.protocol === IP_PROTO_ICMP || packet.protocol === IP_PROTO_ICMPV6;
    if (icmp) {
      const type = packet.icmpType;
      if (type === undefined) return entry('INVALID');
      if (this.family === 6 && ICMPV6_UNTRACKED_TYPES.has(type)) return entry('UNTRACKED');
      if (this.peerType(type) === undefined) return entry('INVALID');
    }

    const tcp = packet.protocol === IP_PROTO_TCP && packet.tcpFlags !== undefined;
    if (tcp && !TCP_VALID_FLAGS.has(packet.tcpFlags! & ~(TCP_ECE | TCP_CWR | TCP_PSH))) return entry('INVALID');

    const hit = this.lookup(packet);
    if (hit === undefined) return this.evaluateNew(packet, tcp);
    return tcp ? this.evaluateTcp(packet, hit) : this.evaluateExisting(packet, hit);
  }

  private evaluateError(packet: TrackedPacket, related: ConnectionTuple): TrackedEntry {
    const inverted = this.reverseOf(related);
    const hit = inverted === null ? undefined : this.lookup(inverted);
    if (hit === undefined) return entry('INVALID');
    const found = hit.direction === 'original' ? hit.flow.original : hit.flow.reply;
    return packet.dstIP === found.dstIP ? entry('RELATED', { hit }) : entry('INVALID');
  }

  private evaluateNew(packet: TrackedPacket, tcp: boolean): TrackedEntry {
    const original = connectionTupleOf(packet);
    const reply = this.reverseOf(original);
    if (reply === null) return entry('INVALID');
    const icmp = packet.protocol === IP_PROTO_ICMP || packet.protocol === IP_PROTO_ICMPV6;
    if (icmp && !this.requestTypes().has(packet.icmpType!)) return entry('INVALID');
    const now = simulationNowMs();
    const flow: Flow = {
      original, reply, snat: false, dnat: false, natDone: { source: false, destination: false },
      createdAt: now, expiresAt: now, seenReply: false, assured: false, tcpState: null, mark: 0, masqueradeInterface: null,
      simultaneousOpen: false, closeInitiated: false, lastIndex: null, lastDirection: null,
    };
    if (tcp) {
      const index = tcpIndexOf(packet.tcpFlags!);
      const first = TCP_TRANSITIONS.original[index][0];
      if (first === 'INVALID' || first === 'IGNORE') return entry('INVALID');
      flow.tcpState = first;
      flow.lastIndex = index;
      flow.lastDirection = 'original';
      flow.expiresAt = now + (first === 'ESTABLISHED' ? TCP_UNACKNOWLEDGED_TIMEOUT_MS : TCP_TIMEOUT_MS[first]);
    } else {
      flow.expiresAt = now + this.initialTimeout(packet.protocol);
    }
    return entry('NEW', { pending: flow });
  }

  private evaluateExisting(packet: TrackedPacket, hit: Hit): TrackedEntry {
    const { flow, direction } = hit;
    const state: ConnectionState = direction === 'reply' || flow.seenReply ? 'ESTABLISHED' : 'NEW';
    return entry(state, {
      hit,
      commit: () => {
        const now = simulationNowMs();
        const replied = flow.seenReply;
        if (direction === 'reply') flow.seenReply = true;
        flow.expiresAt = now + this.refreshedTimeout(flow, packet.protocol, replied, now);
        if (DATAGRAM_PROTOCOLS.has(packet.protocol) && replied && now > flow.createdAt + STREAM_AFTER_MS) flow.assured = true;
        if (packet.protocol === IP_PROTO_GRE && replied) flow.assured = true;
      },
    });
  }

  private evaluateTcp(packet: TrackedPacket, hit: Hit): TrackedEntry {
    const { flow, direction } = hit;
    const index = tcpIndexOf(packet.tcpFlags!);
    const previous = flow.tcpState ?? 'NONE';
    const previousColumn = TCP_STATE_COLUMNS.indexOf(previous);
    const cell = TCP_TRANSITIONS[direction][index][previousColumn];
    if (cell === 'INVALID') return entry('INVALID');

    const ctinfo: ConnectionState = direction === 'reply' || flow.seenReply ? 'ESTABLISHED' : 'NEW';
    const afterClose = previousColumn >= TCP_STATE_COLUMNS.indexOf('TIME_WAIT');
    if (cell === 'SYN_SENT' && afterClose
      && (flow.closeInitiated || (flow.lastDirection === direction && flow.lastIndex === 'rst'))) {
      const fresh = this.evaluateNew(packet, true);
      return entry(fresh.state, { pending: fresh.pending ?? undefined, commit: () => this.remove(flow) });
    }

    if (cell === 'IGNORE' || (cell === 'SYN_SENT' && afterClose)) {
      return entry(ctinfo, {
        hit,
        commit: () => {
          flow.lastIndex = index;
          flow.lastDirection = direction;
        },
      });
    }

    return entry(ctinfo, {
      hit,
      commit: () => {
        const now = simulationNowMs();
        let next: TcpConntrackState = cell;
        if (cell === 'SYN_SENT2') flow.simultaneousOpen = true;
        if (cell === 'SYN_RECV' && direction === 'reply' && index === 'ack' && flow.simultaneousOpen) next = 'ESTABLISHED';
        flow.lastIndex = index;
        flow.lastDirection = direction;
        flow.tcpState = next;
        if (previous !== next && next === 'FIN_WAIT') flow.closeInitiated = true;

        const replied = flow.seenReply;
        if (!replied && direction === 'reply' && index === 'rst') {
          this.remove(flow);
          return;
        }
        let timeout = index === 'rst' ? TCP_TIMEOUT_MS.CLOSE : TCP_TIMEOUT_MS[next];
        if (!replied) {
          if (index === 'syn' && previous === 'SYN_SENT') timeout = Math.max(0, flow.expiresAt - now);
          else if (next === 'ESTABLISHED' && timeout > TCP_UNACKNOWLEDGED_TIMEOUT_MS) timeout = TCP_UNACKNOWLEDGED_TIMEOUT_MS;
        } else if (!flow.assured && (previous === 'SYN_RECV' || previous === 'ESTABLISHED') && next === 'ESTABLISHED') {
          flow.assured = true;
        }
        if (direction === 'reply') flow.seenReply = true;
        flow.expiresAt = now + timeout;
      },
    });
  }

  private flowOf(tracked: TrackedEntry): Flow | null {
    return tracked.hit?.flow ?? tracked.pending;
  }

  private alterReply(flow: Flow, reply: ConnectionTuple): void {
    const indexed = this.index.get(keyOf(flow.reply))?.flow === flow;
    if (indexed) this.index.delete(keyOf(flow.reply));
    flow.reply = reply;
    if (indexed) this.index.set(keyOf(reply), { flow, direction: 'reply' });
  }

  private natWorld(flow: Flow): NatWorld {
    return {
      taken: (candidate) => {
        const reply = this.reverseOf(candidate);
        const hit = reply === null ? undefined : this.index.get(keyOf(reply));
        return hit !== undefined && hit.flow !== flow && hit.flow.expiresAt > simulationNowMs();
      },
      mappedSources: (current) => this.liveFlows(simulationNowMs())
        .filter((other) => other !== flow && other.natDone.source && other.original.protocol === current.protocol
          && other.original.srcIP === current.srcIP && other.original.srcPort === current.srcPort
          && other.original.icmpId === current.icmpId)
        .map((other) => ({
          ...current, srcIP: other.reply.dstIP, srcPort: other.reply.dstPort,
          ...(other.reply.icmpId === undefined ? {} : { icmpId: other.reply.icmpId }),
        })),
      randomOffset: () => {
        this.randomState = (Math.imul(this.randomState, 1664525) + 1013904223) >>> 0;
        return this.randomState >>> 16;
      },
    };
  }

  private liveFlows(now: number): readonly Flow[] {
    const live = new Set<Flow>();
    for (const { flow } of this.index.values()) if (flow.expiresAt > now) live.add(flow);
    return [...live];
  }

  private lookup(tuple: ConnectionTuple): Hit | undefined {
    const hit = this.index.get(keyOf(tuple));
    if (hit === undefined) return undefined;
    if (hit.flow.expiresAt <= simulationNowMs()) {
      this.remove(hit.flow);
      return undefined;
    }
    return hit;
  }

  private remove(flow: Flow): void {
    this.index.delete(keyOf(flow.original));
    this.index.delete(keyOf(flow.reply));
  }

  private purge(now: number): void {
    this.purgedAt = now;
    for (const { flow } of [...this.index.values()]) {
      if (flow.expiresAt <= now) this.remove(flow);
    }
  }

  private peerType(type: number): number | undefined {
    return (this.family === 6 ? ICMPV6_PEER_TYPE : ICMPV4_PEER_TYPE)[type];
  }

  private requestTypes(): ReadonlySet<number> {
    return this.family === 6 ? ICMPV6_REQUEST_TYPES : ICMPV4_REQUEST_TYPES;
  }

  private reverseOf(tuple: ConnectionTuple): ConnectionTuple | null {
    const icmp = tuple.protocol === IP_PROTO_ICMP || tuple.protocol === IP_PROTO_ICMPV6;
    const peer = icmp && tuple.icmpType !== undefined ? this.peerType(tuple.icmpType) : undefined;
    if (icmp && peer === undefined) return null;
    return {
      protocol: tuple.protocol, srcIP: tuple.dstIP, srcPort: tuple.dstPort, dstIP: tuple.srcIP, dstPort: tuple.srcPort,
      ...(peer === undefined ? {} : { icmpType: peer }),
      ...(tuple.icmpId === undefined ? {} : { icmpId: tuple.icmpId }),
      ...(tuple.icmpCode === undefined ? {} : { icmpCode: tuple.icmpCode }),
    };
  }

  private initialTimeout(protocol: number): number {
    if (DATAGRAM_PROTOCOLS.has(protocol)) return UDP_UNREPLIED_TIMEOUT_MS;
    if (protocol === IP_PROTO_GRE) return GRE_UNREPLIED_TIMEOUT_MS;
    if (protocol === IP_PROTO_ICMP || protocol === IP_PROTO_ICMPV6) return ICMP_TIMEOUT_MS;
    return GENERIC_TIMEOUT_MS;
  }

  private refreshedTimeout(flow: Flow, protocol: number, replied: boolean, now: number): number {
    if (DATAGRAM_PROTOCOLS.has(protocol)) {
      return replied && now > flow.createdAt + STREAM_AFTER_MS ? UDP_REPLIED_TIMEOUT_MS : UDP_UNREPLIED_TIMEOUT_MS;
    }
    if (protocol === IP_PROTO_GRE) return replied ? GRE_REPLIED_TIMEOUT_MS : GRE_UNREPLIED_TIMEOUT_MS;
    return this.initialTimeout(protocol);
  }
}

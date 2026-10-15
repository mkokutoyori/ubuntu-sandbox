import type { IPv4Packet } from '../../../core/types';
import { simulationNowMs } from '@/network/core/SystemClock';
import { IsnGenerator } from '../../../tcp/IsnGenerator';
import { noFlags, computeTcpChecksum, TCP_DEFAULT_MSS, type TcpSegment, type TcpOption } from '../../../tcp/types';

export type InterceptMode = 'intercept' | 'watch';
export type InterceptDropMode = 'oldest' | 'random';

export interface TcpInterceptSettings {
  list: number | null;
  mode: InterceptMode;
  dropMode: InterceptDropMode;
  connectionTimeoutSec: number;
  finrstTimeoutSec: number;
  watchTimeoutSec: number;
  maxIncompleteHigh: number;
  maxIncompleteLow: number;
  oneMinuteHigh: number;
  oneMinuteLow: number;
}

export const DEFAULT_INTERCEPT_SETTINGS: Readonly<TcpInterceptSettings> = Object.freeze({
  list: null, mode: 'intercept', dropMode: 'oldest',
  connectionTimeoutSec: 86400, finrstTimeoutSec: 5, watchTimeoutSec: 30,
  maxIncompleteHigh: 1100, maxIncompleteLow: 900, oneMinuteHigh: 1100, oneMinuteLow: 900,
});

export type InterceptState = 'SYNRCVD' | 'SYNSENT' | 'ESTAB';

export interface InterceptConnection {
  readonly client: string;
  readonly clientPort: number;
  readonly server: string;
  readonly serverPort: number;
  readonly mode: 'I' | 'W';
  state: InterceptState;
  readonly createdMs: number;
  lastMs: number;
  deadlineMs: number;
  finrstMs: number | null;
  readonly clientIsn: number;
  readonly routerIsn: number;
  serverIsn: number;
  delta: number;
  readonly clientMss: number;
  readonly clientWindow: number;
  retransmitAtMs: number;
  retransmitIntervalMs: number;
}

export type InterceptSend = (source: string, destination: string, segment: TcpSegment) => void;

export type InterceptAclTest = (list: number, packet: IPv4Packet) => boolean;

export interface TcpInterceptPort {
  process(packet: IPv4Packet, aclPermits: InterceptAclTest, send: InterceptSend): IPv4Packet | null;
  sweep(send: InterceptSend): void;
  hasWork(): boolean;
}

export interface TcpInterceptConfig {
  readonly settings: TcpInterceptSettings;
}

const AGGRESSIVE_RETRANSMIT_MS = 500;
const NORMAL_RETRANSMIT_MS = 1000;
const REQUEST_WINDOW_MS = 60_000;

function connectionKey(client: string, clientPort: number, server: string, serverPort: number): string {
  return `${client}:${clientPort}>${server}:${serverPort}`;
}

function mssOf(options: readonly TcpOption[]): number {
  const found = options.find((option) => option.kind === 'mss');
  return found?.kind === 'mss' ? found.value : TCP_DEFAULT_MSS;
}

export class TcpIntercept implements TcpInterceptPort {
  private readonly connections = new Map<string, InterceptConnection>();
  private readonly requestTimes: number[] = [];
  private readonly isn = new IsnGenerator();
  private aggressive = false;
  private requestsTotal = 0;

  constructor(private readonly source: () => TcpInterceptConfig) {}

  private get settings(): TcpInterceptSettings {
    return this.source().settings;
  }

  private segmentOf(packet: IPv4Packet): TcpSegment | null {
    const segment = packet.payload as TcpSegment | undefined;
    return segment?.type === 'tcp' && packet.protocol === 6 ? segment : null;
  }

  private build(
    source: string, destination: string, from: number, to: number, fields: {
      sequence: number; acknowledgement: number; syn?: boolean; ack?: boolean; rst?: boolean;
      window?: number; options?: TcpOption[];
    },
  ): TcpSegment {
    const flags = noFlags();
    flags.syn = fields.syn === true;
    flags.ack = fields.ack === true;
    flags.rst = fields.rst === true;
    const options = fields.options ?? [];
    const segment: TcpSegment = {
      type: 'tcp', sourcePort: from, destinationPort: to,
      sequence: fields.sequence >>> 0, acknowledgement: fields.acknowledgement >>> 0,
      dataOffset: 5 + (options.length > 0 ? 1 : 0), flags, window: fields.window ?? 8192, checksum: 0,
      urgentPointer: 0, options, payload: undefined,
    };
    segment.checksum = computeTcpChecksum(segment, source, destination);
    return segment;
  }

  private retransmitInterval(): number {
    return this.aggressive ? AGGRESSIVE_RETRANSMIT_MS : NORMAL_RETRANSMIT_MS;
  }

  private incompleteLifetimeMs(): number {
    return this.settings.watchTimeoutSec * 1000 / (this.aggressive ? 2 : 1);
  }

  private incomplete(): InterceptConnection[] {
    return [...this.connections.values()].filter((c) => c.state !== 'ESTAB');
  }

  private pruneRequests(now: number): number {
    while (this.requestTimes.length > 0 && now - this.requestTimes[0] >= REQUEST_WINDOW_MS) this.requestTimes.shift();
    return this.requestTimes.length;
  }

  private updateAggression(now: number): void {
    const s = this.settings;
    const count = this.incomplete().length;
    const rate = this.pruneRequests(now);
    if (!this.aggressive && (count >= s.maxIncompleteHigh || rate >= s.oneMinuteHigh)) this.aggressive = true;
    else if (this.aggressive && count <= s.maxIncompleteLow && rate <= s.oneMinuteLow) this.aggressive = false;
  }

  private drop(connection: InterceptConnection, send: InterceptSend): void {
    const needsReset = connection.mode === 'W' ? connection.state !== 'ESTAB' : connection.state === 'SYNSENT';
    if (needsReset) {
      send(connection.client, connection.server, this.build(connection.client, connection.server,
        connection.clientPort, connection.serverPort, {
          sequence: (connection.clientIsn + 1) >>> 0, acknowledgement: 0, rst: true, window: 0,
        }));
    }
    this.connections.delete(connectionKey(connection.client, connection.clientPort, connection.server, connection.serverPort));
  }

  private evictOne(send: InterceptSend): void {
    const candidates = this.incomplete().sort((a, b) => a.createdMs - b.createdMs);
    if (candidates.length === 0) return;
    const victim = this.settings.dropMode === 'random'
      ? candidates[Math.floor(Math.random() * candidates.length)] : candidates[0];
    this.drop(victim, send);
  }

  private sendSynAck(connection: InterceptConnection, send: InterceptSend): void {
    send(connection.server, connection.client, this.build(connection.server, connection.client,
      connection.serverPort, connection.clientPort, {
        sequence: connection.routerIsn, acknowledgement: (connection.clientIsn + 1) >>> 0,
        syn: true, ack: true, options: [{ kind: 'mss', value: Math.min(connection.clientMss, TCP_DEFAULT_MSS) }],
      }));
  }

  private sendSynToServer(connection: InterceptConnection, send: InterceptSend): void {
    send(connection.client, connection.server, this.build(connection.client, connection.server,
      connection.clientPort, connection.serverPort, {
        sequence: connection.clientIsn, acknowledgement: 0, syn: true, window: connection.clientWindow,
        options: [{ kind: 'mss', value: connection.clientMss }],
      }));
  }

  private rewrite(packet: IPv4Packet, segment: TcpSegment, sequence: number, acknowledgement: number): IPv4Packet {
    const rewritten: TcpSegment = { ...segment, sequence: sequence >>> 0, acknowledgement: acknowledgement >>> 0 };
    rewritten.checksum = computeTcpChecksum(rewritten, packet.sourceIP.toString(), packet.destinationIP.toString());
    return { ...packet, payload: rewritten };
  }

  private noteClosing(connection: InterceptConnection, segment: TcpSegment, now: number): void {
    if (segment.flags.fin || segment.flags.rst) connection.finrstMs = now + this.settings.finrstTimeoutSec * 1000;
  }

  process(packet: IPv4Packet, aclPermits: InterceptAclTest, send: InterceptSend): IPv4Packet | null {
    const segment = this.segmentOf(packet);
    const settings = this.settings;
    if (!segment || settings.list === null) return packet;
    const now = simulationNowMs();
    const source = packet.sourceIP.toString();
    const destination = packet.destinationIP.toString();

    const forward = this.connections.get(connectionKey(source, segment.sourcePort, destination, segment.destinationPort));
    const reverse = forward ? undefined
      : this.connections.get(connectionKey(destination, segment.destinationPort, source, segment.sourcePort));
    const connection = forward ?? reverse;

    if (!connection) {
      const syn = segment.flags.syn && !segment.flags.ack && !segment.flags.rst;
      if (!syn || !aclPermits(settings.list, packet)) return packet;
      this.updateAggression(now);
      if (this.aggressive) this.evictOne(send);
      this.requestTimes.push(now);
      this.requestsTotal += 1;
      const intercepting = settings.mode === 'intercept';
      const created: InterceptConnection = {
        client: source, clientPort: segment.sourcePort, server: destination, serverPort: segment.destinationPort,
        mode: intercepting ? 'I' : 'W', state: 'SYNRCVD', createdMs: now, lastMs: now,
        deadlineMs: now + this.incompleteLifetimeMs(), finrstMs: null,
        clientIsn: segment.sequence, routerIsn: this.isn.next(now, destination, segment.destinationPort, source, segment.sourcePort),
        serverIsn: 0, delta: 0, clientMss: mssOf(segment.options), clientWindow: segment.window,
        retransmitAtMs: now + this.retransmitInterval(), retransmitIntervalMs: this.retransmitInterval(),
      };
      this.connections.set(connectionKey(source, segment.sourcePort, destination, segment.destinationPort), created);
      if (!intercepting) return packet;
      this.sendSynAck(created, send);
      return null;
    }

    connection.lastMs = now;
    if (connection.mode === 'W') return this.watch(connection, forward !== undefined, segment, packet, now);
    return forward ? this.fromClient(connection, segment, packet, now, send) : this.fromServer(connection, segment, packet, now, send);
  }

  private watch(
    connection: InterceptConnection, fromClient: boolean, segment: TcpSegment, packet: IPv4Packet, now: number,
  ): IPv4Packet {
    if (segment.flags.rst) {
      this.connections.delete(connectionKey(connection.client, connection.clientPort, connection.server, connection.serverPort));
      return packet;
    }
    if (connection.state === 'SYNRCVD' && !fromClient && segment.flags.syn && segment.flags.ack) connection.state = 'SYNSENT';
    else if (connection.state === 'SYNSENT' && fromClient && segment.flags.ack && !segment.flags.syn) {
      connection.state = 'ESTAB';
      connection.deadlineMs = now + this.settings.connectionTimeoutSec * 1000;
    }
    if (connection.state === 'ESTAB') this.noteClosing(connection, segment, now);
    return packet;
  }

  private fromClient(
    connection: InterceptConnection, segment: TcpSegment, packet: IPv4Packet, now: number, send: InterceptSend,
  ): IPv4Packet | null {
    if (segment.flags.rst && connection.state !== 'ESTAB') {
      this.connections.delete(connectionKey(connection.client, connection.clientPort, connection.server, connection.serverPort));
      return null;
    }
    if (connection.state === 'SYNRCVD') {
      if (segment.flags.syn) {
        this.sendSynAck(connection, send);
        return null;
      }
      if (segment.flags.ack && segment.acknowledgement === ((connection.routerIsn + 1) >>> 0)) {
        connection.state = 'SYNSENT';
        connection.retransmitIntervalMs = this.retransmitInterval();
        connection.retransmitAtMs = now + connection.retransmitIntervalMs;
        this.sendSynToServer(connection, send);
      }
      return null;
    }
    if (connection.state === 'SYNSENT') return null;
    this.noteClosing(connection, segment, now);
    connection.deadlineMs = now + this.settings.connectionTimeoutSec * 1000;
    return segment.flags.ack
      ? this.rewrite(packet, segment, segment.sequence, segment.acknowledgement + connection.delta) : packet;
  }

  private fromServer(
    connection: InterceptConnection, segment: TcpSegment, packet: IPv4Packet, now: number, send: InterceptSend,
  ): IPv4Packet | null {
    if (connection.state === 'SYNSENT') {
      if (segment.flags.rst) {
        send(connection.server, connection.client, this.build(connection.server, connection.client,
          connection.serverPort, connection.clientPort, {
            sequence: (connection.routerIsn + 1) >>> 0, acknowledgement: (connection.clientIsn + 1) >>> 0, rst: true, ack: true, window: 0,
          }));
        this.connections.delete(connectionKey(connection.client, connection.clientPort, connection.server, connection.serverPort));
        return null;
      }
      if (segment.flags.syn && segment.flags.ack && segment.acknowledgement === ((connection.clientIsn + 1) >>> 0)) {
        connection.serverIsn = segment.sequence;
        connection.delta = (segment.sequence - connection.routerIsn) >>> 0;
        connection.state = 'ESTAB';
        connection.deadlineMs = now + this.settings.connectionTimeoutSec * 1000;
        send(connection.client, connection.server, this.build(connection.client, connection.server,
          connection.clientPort, connection.serverPort, {
            sequence: (connection.clientIsn + 1) >>> 0, acknowledgement: (segment.sequence + 1) >>> 0, ack: true,
            window: connection.clientWindow,
          }));
      }
      return null;
    }
    if (connection.state !== 'ESTAB') return null;
    this.noteClosing(connection, segment, now);
    connection.deadlineMs = now + this.settings.connectionTimeoutSec * 1000;
    return this.rewrite(packet, segment, segment.sequence - connection.delta, segment.acknowledgement);
  }

  sweep(send: InterceptSend): void {
    const now = simulationNowMs();
    for (const connection of [...this.connections.values()]) {
      const key = connectionKey(connection.client, connection.clientPort, connection.server, connection.serverPort);
      if (connection.finrstMs !== null && now >= connection.finrstMs) {
        this.connections.delete(key);
        continue;
      }
      if (connection.state === 'ESTAB') {
        if (now >= connection.deadlineMs) this.connections.delete(key);
        continue;
      }
      if (now >= connection.deadlineMs) {
        this.drop(connection, send);
        continue;
      }
      if (connection.mode === 'I' && now >= connection.retransmitAtMs) {
        if (connection.state === 'SYNRCVD') this.sendSynAck(connection, send);
        else this.sendSynToServer(connection, send);
        connection.retransmitIntervalMs *= 2;
        connection.retransmitAtMs = now + connection.retransmitIntervalMs;
      }
    }
    this.updateAggression(now);
  }

  hasWork(): boolean {
    return this.connections.size > 0;
  }

  list(): InterceptConnection[] {
    this.sweepExpired();
    return [...this.connections.values()];
  }

  private sweepExpired(): void {
    const now = simulationNowMs();
    for (const [key, connection] of [...this.connections]) {
      const done = (connection.finrstMs !== null && now >= connection.finrstMs)
        || (connection.state === 'ESTAB' && now >= connection.deadlineMs);
      if (done) this.connections.delete(key);
    }
  }

  statistics(): { incomplete: number; established: number; rate: number; aggressive: boolean; requests: number } {
    this.sweepExpired();
    const all = [...this.connections.values()];
    return {
      incomplete: all.filter((c) => c.state !== 'ESTAB').length,
      established: all.filter((c) => c.state === 'ESTAB').length,
      rate: Math.round(this.pruneRequests(simulationNowMs()) / 60),
      aggressive: this.aggressive,
      requests: this.requestsTotal,
    };
  }

  clear(): void {
    this.connections.clear();
  }
}

import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  type TcpSegment, type TcpFlags, type TcpState, type TcpCloseReason,
  type UnackedSegment, type TcpOption, type TcpWireOutcome, type TcpErrorReport,
  noFlags, flagsString, randomSequenceNumber, makeSocketKey, makeListenerKey,
  computeTcpChecksum, verifyTcpChecksum, seqLt,
  TCP_DEFAULT_MSS, TCP_DEFAULT_WINDOW, TCP_TIME_WAIT_MS, TCP_MIN_MSS, TCP_BASE_HEADER_BYTES,
} from './types';
import { bogusChecksum, payloadBytes } from '@/network/layers/transport/L4Checksum';
import { type StreamPayload, isStreamPayload, sliceStream, appendStream } from './StreamPayload';
import { fragmentIPv4, IPV4_FLAG_DF } from '@/network/core/Ipv4Fragmentation';
import { PortNumber, PORT_ANY } from '@/network/core/ports/PortNumber';
import type { PortBindingPolicy } from '@/network/core/ports/PortBindingPolicy';
import { PROHIBITED_UNREACH_CODES } from '@/network/core/IcmpErrors';
import { DiffServField, type TimeToLive } from '@/network/core/IpHeaderFields';

/**
 * Ce qu'une sonde apatride a vu revenir. `rst-window` distingue un RST a
 * fenetre NON NULLE, seul detail que le balayage par fenetre (`nmap -sW`)
 * regarde : `scan_engine_raw.cc` y lit `(tcp.th_win) ? PORT_OPEN :
 * PORT_CLOSED`.
 */
export type StatelessProbeReply =
  | 'rst' | 'rst-window' | 'syn-ack'
  | 'icmp-prohibited' | 'icmp-unreachable' | 'none';

/**
 * Ce qu'un balayeur COMPOSE dans sa sonde au lieu de laisser la pile le
 * decider — les trois options d'evasion de `nmap` que ce simulateur juge
 * reellement : `-g`/`--source-port`, `--ttl` et `--badsum`.
 */
export interface ScanProbeShape {
  sourcePort?: number;
  ttl?: number;
  badChecksum?: boolean;
  /**
   * `-f`/`--mtu` : la taille de la CHARGE de chaque fragment, en-tete
   * IPv4 exclu (`NmapOps.h:253`, « 0 or MTU (without IPv4 header
   * size) »). Demander un decoupage CLAIRE le bit DF, qu'un datagramme
   * fragmente ne peut pas porter — c'est pourquoi les sondes brutes de
   * nmap le laissent a zero (`scan_engine_raw.cc:1075`).
   */
  fragmentMtu?: number;
  /**
   * `-S`/`-D` : l'adresse source FORGEE de la sonde. La reponse part
   * alors vers elle et non vers nous, ce qui est tout l'objet des deux
   * options — et ce qui fait qu'un leurre ne rapporte aucun verdict.
   */
  sourceIp?: string;
  payload?: Uint8Array;
  iface?: string;
  /**
   * `hping3 -w`/`--win` : la fenetre ANNONCEE par la sonde. Absente, la
   * pile pose la sienne.
   */
  window?: number;
  sequence?: number;
  acknowledgement?: number;
  tos?: number;
  identification?: number;
  dontFragment?: boolean;
}

export interface StatelessProbeDetail {
  reply: StatelessProbeReply;
  window: number;
  icmpType?: number;
  icmpCode?: number;
  icmpFrom?: string;
  flags: TcpFlags;
  sequence: number;
  acknowledgement: number;
  checksum: number;
  urgentPointer: number;
  ttl: number;
  identification: number;
  tos: number;
  totalLength: number;
  dontFragment: boolean;
}

export interface ReceivedIpHeader {
  ttl: number;
  identification: number;
  tos: number;
  totalLength: number;
  dontFragment: boolean;
}

const ICMP_TYPE_DEST_UNREACH = 3;
const ICMP_TYPE_TIME_EXCEEDED = 11;

/** La duree de vie qu'une pile TCP pose sur ses propres segments. */
const TCP_DEFAULT_TTL = 64;

interface StatelessProbeWatch {
  seen: 'rst' | 'syn-ack' | 'icmp-prohibited' | 'icmp-unreachable' | 'none';
  window: number;
  icmpType?: number;
  icmpCode?: number;
  icmpFrom?: string;
  flags: TcpFlags;
  sequence: number;
  acknowledgement: number;
  checksum: number;
  urgentPointer: number;
  ip: ReceivedIpHeader;
  localPort: number;
  destIp: string;
  destPort: number;
}

export function receivedIpHeaderOf(ipPkt: IPv4Packet): ReceivedIpHeader {
  return {
    ttl: ipPkt.ttl,
    identification: ipPkt.identification,
    tos: ipPkt.tos,
    totalLength: ipPkt.totalLength,
    dontFragment: (ipPkt.flags & 0b010) !== 0,
  };
}

const NO_REPLY_IP_HEADER: ReceivedIpHeader = {
  ttl: 0, identification: 0, tos: 0, totalLength: 0, dontFragment: false,
};

function emptyProbeDetail(reply: StatelessProbeReply): StatelessProbeDetail {
  return {
    reply, window: 0, flags: noFlags(), sequence: 0, acknowledgement: 0,
    checksum: 0, urgentPointer: 0, ...NO_REPLY_IP_HEADER,
  };
}

import {
  connectedPrefixesOfPort, invalidSourceFor, isUnicastDestination, type ConnectedIpv4Prefix,
} from '@/network/layers/internet/InternetLayer';
import {
  RttEstimator, TCP_INITIAL_RTO_MS, TCP_MAX_RTO_MS, TCP_R1_RETRANSMITS, TCP_DATA_R2_MS, TCP_SYN_R2_MS,
  TCP_RTO_AFTER_SYN_RETRANSMIT_MS,
} from './RttEstimator';
import { TcpCongestionControl } from './TcpCongestionControl';
import {
  encodeOptions, decodeOptions, interpretOptions, optionsDataOffset, TCP_MAX_WINDOW_SCALE, type TcpOptionsSet,
} from './TcpOptionsCodec';
import { ReassemblyQueue } from './ReassemblyQueue';
import { SackScoreboard } from './SackScoreboard';
import type { TcpDropReason } from './events';
import { AckThrottle } from './AckThrottle';
import { IsnGenerator } from './IsnGenerator';
import {
  DEFAULT_ETHERNET_MTU, LOOPBACK_MTU, defaultSendMss, mssForMtu,
} from './TcpSegmentSize';
import type { ListenerIdentity, ListenerSocketSink } from './ListenerSocketSink';

/** RFC 7323 §2.2 — our own advertised window-scale shift (always offered on SYN). */
const TCP_WINDOW_SCALE_SHIFT = 7;
/** Bound on out-of-order data buffered for reassembly (PRD-TCP.md P6) — one window's worth. */
const TCP_REASSEMBLY_MAX_BYTES = TCP_DEFAULT_WINDOW;
const TCP_MAX_RECEIVE_WINDOW = 2 ** 30;
const TCP_INVALID_ACK_RATELIMIT_MS = 500;
const TCP_TS_RECENT_VALID_MS = 24 * 24 * 60 * 60 * 1000;
const TCP_SWS_OVERRIDE_MS = 500;
const TCP_LIMITED_TRANSMIT_ACKS = 2;
const TCP_LIMITED_TRANSMIT_SLACK_SEGMENTS = 2;
import {
  IPAddress,
  IPv6Address,
  type EthernetFrame,
  type IPv4Packet,
  type IPv6Packet,
  IP_PROTO_TCP,
  createIPv4Packet,
  createIPv6Packet,
} from '../core/types';
import { Logger } from '../core/Logger';

export type IpFamily = 'ipv4' | 'ipv6';

export function ipFamilyOf(ip: string): IpFamily {
  return ip.includes(':') ? 'ipv6' : 'ipv4';
}

export function canonicalIpText(ip: string): string {
  if (ipFamilyOf(ip) === 'ipv4') return IPAddress.tryParse(ip)?.toString() ?? ip;
  try { return new IPv6Address(ip).withScopeId(null).toString(); } catch { return ip; }
}

const OPAQUE_PAYLOAD_SEQUENCE_UNITS = 1;

export function segmentPayloadSize(seg: TcpSegment): number {
  if (seg.payload === undefined) return 0;
  return isStreamPayload(seg.payload) ? seg.payload.length : OPAQUE_PAYLOAD_SEQUENCE_UNITS;
}

export interface TcpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  resolveRoute?(targetIp: string): { iface: string; nextHopIp: string } | null;
  resolveRoute6?(targetIp: string): { iface: string; nextHopIp: string } | null;
  localAddress6?(iface: string, remoteIp: string): string | null;
  /**
   * The send path: queues on a cold ARP cache and resolves the real
   * next-hop MAC. Mandatory — the broadcast fallback it replaced would
   * have flooded a segment with a TCP segment.
   */
  sendIpv4FrameArpAware(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
  sendIpv6FrameNdpAware?(outPortName: string, ipPkt: IPv6Packet, nextHopIP: IPv6Address): void;
  adviseNegative?(nextHopIp: string): void;
  defaultTtl?(family: IpFamily): number | undefined;
}

export interface TcpAcceptHandler {
  (socket: TcpSocket): void;
}

export interface TcpDataHandler {
  (data: unknown): void;
}

export interface TcpCloseHandler {
  (reason: TcpCloseReason): void;
}

export interface TcpOpenHandler {
  (socket: TcpSocket): void;
}

export interface TcpConnectOptions {
  localPort?: PortNumber;
  localIp?: string;
  onOpen?: TcpOpenHandler;
  onData?: TcpDataHandler;
  onClose?: TcpCloseHandler;
  ttl?: TimeToLive;
  diffServ?: DiffServField;
}

export interface TcpListenOptions {
  onAccept: TcpAcceptHandler;
  /**
   * Ce que la `SocketTable` sait en plus de la pile — pid, nom de
   * processus, bannière. Fourni ici plutôt que réinscrit à côté par un
   * `socketTable.bind()` manuel : l'identité voyage avec l'écoute, donc
   * les deux tables ne peuvent plus en diverger.
   */
  identity?: ListenerIdentity;
  ownerUid?: number;
  receiveWindow?: number;
  maxSegmentSize?: number;
  ttl?: TimeToLive;
  diffServ?: DiffServField;
}

export class TcpSocket {
  readonly localIp: string;
  readonly remoteIp: string;
  readonly family: IpFamily;
  localPort: number;
  remotePort: number;
  state: TcpState = 'closed';
  ttl: TimeToLive | null = null;
  diffServ: DiffServField = DiffServField.DEFAULT;
  sendNext = 0;
  sendUnacked = 0;
  recvNext = 0;
  /** SND.UP (RFC 9293 §3.3.1) — one past the last urgent octet we have queued, or null outside urgent mode. */
  sndUp: number | null = null;
  /** RCV.UP (RFC 9293 §3.3.1) — one past the last urgent octet the peer has designated. */
  rcvUp: number | null = null;
  private receiveCapacity = TCP_DEFAULT_WINDOW;
  rcvEdge: number | null = null;
  swsHeld = false;
  swsOverride = false;
  limitedTransmitCredits = 0;
  limitedTransmitBytes = 0;
  mss = TCP_DEFAULT_MSS;
  passive = false;
  closed = false;
  closeReason: TcpCloseReason | null = null;
  connectRefused = false;
  /**
   * A filter said no, out loud: ICMP administratively prohibited (codes
   * 9, 10 and 13). The kernel reports EACCES rather than ECONNREFUSED,
   * and `scan_engine_connect.cc` reads that as FILTERED, not closed — the
   * distinction between "nothing listens here" and "something forbids it".
   */
  connectProhibited = false;
  /**
   * The handshake completed at least once. A peer that accepts and then
   * closes straight away — a telnet VTY refusing the line, an SMTP server
   * that greets with 421 — has an OPEN port; judging that off the socket's
   * *current* state would call it refused, which is the opposite answer.
   */
  everEstablished = false;
  pendingSendQueue: unknown[] = [];
  closeAfterFlush = false;
  recvBuffer: StreamPayload | null = null;
  /** 2MSL timer token while in TIME-WAIT (RFC 9293 §3.4.1). */
  timeWaitTimer: symbol | null = null;
  /**
   * PID of the userspace process that owns this socket. Set by the
   * listener via `stack.setSocketOwner(...)` so `abortSocketsOwnedBy(pid)`
   * can slam-close everything when the process dies.
   */
  ownerPid: number | null = null;

  /** Segments (SYN/data/FIN) sent but not yet covered by an ACK (PRD-TCP.md P1). */
  unackedQueue: UnackedSegment[] = [];
  /** Retransmission-timeout token for the head of `unackedQueue`, or null when nothing is outstanding. */
  rtoTimer: symbol | null = null;
  readonly rtt: RttEstimator = new RttEstimator();

  /** Peer's last-advertised receive window (PRD-TCP.md P3) — bounds how much unacked data we may have in flight. */
  peerWindow = TCP_DEFAULT_WINDOW;
  sendBacklog: Array<{ payload: StreamPayload; psh: boolean }> = [];
  noDelay = false;
  segmentsSinceAck = 0;
  delayedAckTimer: symbol | null = null;
  /** Zero-window persist-probe timer (RFC 9293 §3.8.6.1). */
  persistTimer: symbol | null = null;
  persistBackoffMs = 0;
  /**
   * Reentrancy guard for `flushSendBacklog` (PRD-TCP.md P3/P5) — this
   * simulator delivers frames synchronously end to end, so transmitting a
   * segment can synchronously trigger the peer's ACK, which re-enters this
   * same socket's flush before the outer call's `while` loop has looped
   * again. Left unguarded, every additional segment nests one more level
   * of send→ACK→send call stack instead of being a new iteration of the
   * same loop, growing JS call-stack depth linearly with segment count —
   * for a large transfer this silently trips `Cable`'s anti-loop guard
   * (`MAX_SYNC_DELIVERY_DEPTH`) partway through, dropping the tail of the
   * data with no error. The guard flattens this: a reentrant call is a
   * no-op (the outer loop recomputes window/backlog fresh on its next
   * iteration anyway, since the ACK already updated them), so total depth
   * stays bounded by one round trip's cable hops, not by segment count.
   */
  flushingBacklog = false;
  readonly openedAtBurstDepth: number = burstDepth;

  /** RFC 5681 congestion control (PRD-TCP.md P5) — slow start/congestion avoidance/fast recovery. */
  readonly cc: TcpCongestionControl = new TcpCongestionControl(this.mss);
  readonly sackScoreboard = new SackScoreboard();
  lastDataSentAtMs: number | null = null;

  /** Our own advertised window-scale shift (PRD-TCP.md P6, RFC 7323 §2.2) — always offered on SYN. */
  readonly windowScale = TCP_WINDOW_SCALE_SHIFT;
  /** Peer's window-scale shift, present only if negotiated (both sides must offer it on their SYN). */
  peerWindowScale: number | null = null;
  /** True only when both sides negotiated SACK on their SYN (RFC 2018). */
  sackEnabled = false;
  /** True only when both sides negotiated timestamps on their SYN (RFC 7323 §3). */
  timestampsEnabled = false;
  /** Highest timestamp value seen from the peer — echoed back, and used for PAWS (RFC 7323 §5). */
  peerLastTsVal: number | null = null;
  readonly reassemblyBuffer = new ReassemblyQueue();
  pendingListener: TcpListener | null = null;
  sendWl1 = 0;
  sendWl2 = 0;
  maxPeerWindow = 0;
  lastAckSent = 0;
  peerTsRecentAtMs = 0;
  lastOutOfWindowAckAt: number | null = null;
  userTimeoutMs: number | null = null;
  lastHeardAtMs = 0;
  troubleReportedFor: number | null = null;
  private readonly errorReportHandlers: Array<(report: TcpErrorReport) => void> = [];

  /** PRD-TCP.md P8 (RFC 9293 §3.8.4, SO_KEEPALIVE) — optional idle-probe timer, off by default. */
  keepAliveEnabled = false;
  keepAliveIdleMs = 0;
  keepAliveIntervalMs = 0;
  keepAliveMaxProbes = 0;
  keepAliveProbesSent = 0;
  keepAliveTimer: symbol | null = null;

  private readonly openHandlers: TcpOpenHandler[] = [];
  private readonly dataHandlers: TcpDataHandler[] = [];
  private readonly closeHandlers: TcpCloseHandler[] = [];
  private readonly urgentHandlers: Array<(lastUrgentByte: string) => void> = [];

  constructor(
    readonly stack: TcpStack,
    localIp: string, localPort: number,
    remoteIp: string, remotePort: number,
  ) {
    this.localIp = localIp;
    this.localPort = localPort;
    this.remoteIp = remoteIp;
    this.remotePort = remotePort;
    this.family = ipFamilyOf(remoteIp);
  }

  send(data: unknown): void { this.stack._sendData(this, data); }
  write(data: string): void { this.stack._sendData(this, data); }

  /**
   * RFC 9293 §3.8.5 — the urgent mechanism, which MUST-30 requires a TCP
   * implementation to carry even though SHLD-13 tells new applications not
   * to reach for it. The data still travels in the stream; what URG adds is
   * a point designating where the urgent information ENDS.
   */
  sendUrgent(data: string): void { this.stack._sendUrgentData(this, data); }

  /** True while the peer's urgent point is in advance of RCV.NXT (RFC 9293 §3.8.5). */
  get urgentMode(): boolean {
    return this.rcvUp !== null && seqLt(this.recvNext, this.rcvUp);
  }

  onUrgent(handler: (lastUrgentByte: string) => void): () => void {
    this.urgentHandlers.push(handler);
    return () => {
      const i = this.urgentHandlers.indexOf(handler);
      if (i >= 0) this.urgentHandlers.splice(i, 1);
    };
  }

  _fireUrgent(lastUrgentByte: string): void {
    for (const handler of [...this.urgentHandlers]) handler(lastUrgentByte);
  }
  close(): void { this.stack._initiateClose(this); }

  /**
   * Abandon the connection immediately with an RST (RFC 9293 §3.10.4),
   * bypassing the graceful FIN sequence `close()` uses — analogous to a
   * real socket's `SO_LINGER` with `l_onoff=1, l_linger=0`. `reset()` is
   * the same operation under the name PRD-TCP.md also uses for it.
   */
  abort(): void { this.stack._abort(this); }
  reset(): void { this.stack._abort(this); }

  /**
   * TCP_NODELAY (RFC 9293 §3.7.4): "applications that require low latency
   * on every packet sent MUST be provided with a mechanism to disable
   * Nagle". Turning it on releases whatever Nagle is currently holding.
   */
  setNoDelay(enabled: boolean): void { this.stack._setNoDelay(this, enabled); }

  setTtl(ttl: TimeToLive | null): void { this.ttl = ttl; }
  setDiffServ(field: DiffServField): void { this.diffServ = field; }

  /**
   * Enable RFC 9293 §3.8.4 (SO_KEEPALIVE) idle-probe monitoring: after
   * `idleMs` with no segment received from the peer, send a probe every
   * `intervalMs`; if `maxProbes` probes go unanswered, close the
   * connection as if it had timed out.
   */
  enableKeepAlive(idleMs: number, intervalMs: number = idleMs, maxProbes = 3): void {
    this.stack._enableKeepAlive(this, idleMs, intervalMs, maxProbes);
  }
  disableKeepAlive(): void { this.stack._disableKeepAlive(this); }

  onOpen(handler: TcpOpenHandler): () => void {
    this.openHandlers.push(handler);
    return () => {
      const i = this.openHandlers.indexOf(handler);
      if (i !== -1) this.openHandlers.splice(i, 1);
    };
  }

  onData(handler: TcpDataHandler): () => void {
    const first = this.dataHandlers.length === 0;
    this.dataHandlers.push(handler);
    if (first) this._drainReceiveQueue(handler);
    return () => {
      const i = this.dataHandlers.indexOf(handler);
      if (i !== -1) this.dataHandlers.splice(i, 1);
    };
  }

  onClose(handler: TcpCloseHandler): () => void {
    if (this.closed) {
      handler(this.closeReason ?? 'shutdown');
      return () => {};
    }
    this.closeHandlers.push(handler);
    return () => {
      const i = this.closeHandlers.indexOf(handler);
      if (i !== -1) this.closeHandlers.splice(i, 1);
    };
  }

  setUserTimeout(milliseconds: number | null): void {
    if (milliseconds !== null && !(milliseconds > 0)) {
      throw new Error(`TCP user timeout out of range: ${milliseconds} (EINVAL)`);
    }
    this.userTimeoutMs = milliseconds;
    this.stack._userTimeoutChanged(this);
  }

  onErrorReport(handler: (report: TcpErrorReport) => void): () => void {
    this.errorReportHandlers.push(handler);
    return () => {
      const i = this.errorReportHandlers.indexOf(handler);
      if (i !== -1) this.errorReportHandlers.splice(i, 1);
    };
  }

  _fireErrorReport(report: TcpErrorReport): void {
    for (const h of [...this.errorReportHandlers]) {
      try { h(report); } catch { /* swallow per-handler */ }
    }
  }

  _fireOpen(): void {
    for (const h of [...this.openHandlers]) {
      try { h(this); } catch { /* swallow per-handler */ }
    }
  }

  /**
   * Data that arrived before the application attached its first
   * `onData` handler, held until it does — a real socket keeps received
   * bytes in its receive queue for exactly as long. Without this, every
   * protocol where the server speaks first (telnet's option negotiation
   * and login prompt, an SMTP 220 greeting) loses its opening burst,
   * because the peer writes it synchronously inside `onAccept`, before
   * `connect()` has even returned to the client.
   *
   * Bounded by the advertised receive window: past that a real stack
   * stops accepting, it does not grow without limit.
   */
  private receiveQueue: unknown[] = [];
  private receiveQueueBytes = 0;
  private receivePaused = false;

  get windowSize(): number { return this.receiveCapacity; }

  set windowSize(bytes: number) {
    this.receiveCapacity = bytes;
    this.stack._receiveSpaceFreed(this);
  }

  get unreadBytes(): number { return this.receiveQueueBytes; }

  pause(): void { this.receivePaused = true; }

  resume(): void {
    if (!this.receivePaused) return;
    this.receivePaused = false;
    this._drainReceiveQueue();
  }

  _fireData(data: unknown): void {
    if (this.dataHandlers.length === 0 || this.receivePaused) {
      this.receiveQueue.push(data);
      this.receiveQueueBytes += isStreamPayload(data) ? data.length : OPAQUE_PAYLOAD_SEQUENCE_UNITS;
      return;
    }
    for (const h of [...this.dataHandlers]) {
      try { h(data); } catch { /* swallow per-handler */ }
    }
  }

  _drainReceiveQueue(only?: TcpDataHandler): void {
    if (this.receivePaused || this.dataHandlers.length === 0 || this.receiveQueue.length === 0) return;
    const backlog = this.receiveQueue;
    this.receiveQueue = [];
    this.receiveQueueBytes = 0;
    const handlers = only === undefined ? [...this.dataHandlers] : [only];
    for (const chunk of backlog) {
      for (const h of handlers) {
        try { h(chunk); } catch { /* swallow per-handler */ }
      }
    }
    this.stack._receiveSpaceFreed(this);
  }

  _fireClose(reason: TcpCloseReason): void {
    this.closeReason = reason;
    for (const h of [...this.closeHandlers]) {
      try { h(reason); } catch { /* swallow per-handler */ }
    }
  }

  key(): string { return makeSocketKey(this.localIp, this.localPort, this.remoteIp, this.remotePort); }
}

export type TcpConnection = TcpSocket;
export type TcpConnector = (host: string, port: number) => Promise<TcpConnection | null>;

export class TcpListener {
  constructor(
    readonly localIp: string,
    readonly localPort: number,
    readonly onAccept: TcpAcceptHandler,
    readonly identity: ListenerIdentity = {},
    readonly receiveWindow: number = TCP_DEFAULT_WINDOW,
    readonly maxSegmentSize: number = Number.MAX_SAFE_INTEGER,
    readonly ttl: TimeToLive | null = null,
    readonly diffServ: DiffServField = DiffServField.DEFAULT,
  ) {}

  key(): string { return makeListenerKey(this.localIp, this.localPort); }
}

const socketsOwingAck = new Set<TcpSocket>();
let burstDepth = 0;
let drainingAcks = false;

export const TCP_DELAYED_ACK_MS = 200;
const TCP_ACK_EVERY_N_SEGMENTS = 2;

export class TcpStack {
  private listeners = new Map<string, TcpListener>();
  private sockets = new Map<string, TcpSocket>();
  private enabled = true;
  private running = false;
  private nextEphemeralPort = 49152;
  private ephemeralMin = 49152;
  private ephemeralMax = 65535;
  private startedAtMs = Date.now();

  setEphemeralRange(min: number, max: number): void {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max > 65535 || min > max) {
      throw new Error(`Invalid ephemeral range: [${min}, ${max}]`);
    }
    this.ephemeralMin = min;
    this.ephemeralMax = max;
    this.nextEphemeralPort = min;
  }

  getEphemeralRange(): { min: number; max: number } {
    return { min: this.ephemeralMin, max: this.ephemeralMax };
  }

  private readonly challengeAcks = new AckThrottle();
  private readonly incarnationFloors = new Map<string, number>();
  private readonly isn = new IsnGenerator();
  private readonly timers = new TimerSet(() => this.getScheduler());

  constructor(
    private readonly host: TcpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler =
    () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.timers.clearAll();
    for (const s of Array.from(this.sockets.values())) {
      s.timeWaitTimer = null;
      this._teardown(s, 'shutdown');
    }
    this.sockets.clear();
    for (const l of this.listeners.values()) this.socketSink?.withdraw(l.localIp, l.localPort);
    this.listeners.clear();
  }

  setEnabled(on: boolean): void { this.enabled = on; }

  /**
   * docs/PRD-Sockets-Une-Seule-Verite.md §P1 — le lien vers la table que
   * lisent `ss`, `netstat`, `lsof` et `nmap`. Branché depuis l'intérieur,
   * pas par un abonnement au bus : le bus par défaut est remis à zéro
   * avant chaque test, et un abonné mort ne se voit pas.
   */
  attachSocketSink(sink: ListenerSocketSink): void {
    this.socketSink = sink;
    for (const l of this.listeners.values()) sink.announce(l.localIp, l.localPort, l.identity);
  }

  private socketSink: ListenerSocketSink | null = null;

  private bindingPolicy: PortBindingPolicy | null = null;

  setBindingPolicy(policy: PortBindingPolicy): void {
    this.bindingPolicy = policy;
  }

  listen(localPort: number, opts: TcpListenOptions, localIp = '0.0.0.0'): TcpListener {
    if (!PortNumber.isValid(localPort)) {
      throw new Error(`TCP listener port out of range: ${localPort} (EINVAL)`);
    }
    if (localPort !== PORT_ANY && opts.ownerUid !== undefined && this.bindingPolicy !== null
      && !this.bindingPolicy.permits(localPort, { uid: opts.ownerUid })) {
      throw new Error(`TCP listener on ${localIp}:${localPort} needs CAP_NET_BIND_SERVICE (EACCES)`);
    }
    const boundPort = localPort === PORT_ANY ? this.nextEphemeral(localIp) : localPort;
    if (boundPort < 0) {
      throw new Error(`TCP listener has no free ephemeral port on ${localIp} (EADDRINUSE)`);
    }
    if (opts.receiveWindow !== undefined && !Number.isInteger(opts.receiveWindow)
      || (opts.receiveWindow ?? 0) < 0 || (opts.receiveWindow ?? 0) > TCP_MAX_RECEIVE_WINDOW) {
      throw new Error(`TCP listener receive window out of range: ${opts.receiveWindow} (EINVAL)`);
    }
    if (opts.maxSegmentSize !== undefined
      && (!Number.isInteger(opts.maxSegmentSize) || opts.maxSegmentSize < TCP_MIN_MSS)) {
      throw new Error(`TCP listener maximum segment size out of range: ${opts.maxSegmentSize} (EINVAL)`);
    }
    const listener = new TcpListener(
      localIp, boundPort, opts.onAccept, opts.identity ?? {},
      opts.receiveWindow, opts.maxSegmentSize, opts.ttl ?? null, opts.diffServ ?? DiffServField.DEFAULT);
    if (this.listeners.has(listener.key())) {
      throw new Error(`TCP listener already bound on ${localIp}:${boundPort} (EADDRINUSE)`);
    }
    this.listeners.set(listener.key(), listener);
    this.socketSink?.announce(localIp, boundPort, listener.identity);
    this.getBus().publish({
      topic: 'tcp.listener.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp, localPort: boundPort, added: true,
      },
    });
    return listener;
  }

  closeListener(localPort: number, localIp = '0.0.0.0'): void {
    const key = makeListenerKey(localIp, localPort);
    const listener = this.listeners.get(key);
    if (!this.listeners.delete(key)) return;
    for (const pending of [...this.sockets.values()]) {
      if (pending.pendingListener === listener) this._teardown(pending, 'shutdown');
    }
    this.socketSink?.withdraw(localIp, localPort);
    this.getBus().publish({
      topic: 'tcp.listener.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp, localPort, added: false,
      },
    });
  }

  listListeners(): TcpListener[] {
    return Array.from(this.listeners.values()).sort((a, b) =>
      a.localPort === b.localPort ? a.localIp.localeCompare(b.localIp) : a.localPort - b.localPort);
  }

  listSockets(): TcpSocket[] {
    return Array.from(this.sockets.values()).sort((a, b) => a.key().localeCompare(b.key()));
  }

  abortSocketsOwnedBy(pid: number): number {
    let count = 0;
    for (const sock of Array.from(this.sockets.values())) {
      if (sock.ownerPid !== pid) continue;
      this._teardown(sock, 'shutdown');
      count++;
    }
    return count;
  }

  /**
   * Tear down every socket whose peer `isReachable` now rejects — the
   * simulator's equivalent of a link going down under established
   * connections. Listeners are untouched: a server keeps its bound port
   * across a cable failure (docs/PRD-Link-State.md §2.1 P5).
   */
  abortUnreachableSockets(isReachable: (remoteIp: string) => boolean): number {
    let count = 0;
    for (const sock of Array.from(this.sockets.values())) {
      if (isReachable(sock.remoteIp)) continue;
      this._teardown(sock, 'shutdown');
      count++;
    }
    return count;
  }

  setSocketOwner(socket: TcpSocket, pid: number): void {
    socket.ownerPid = pid;
  }

  clock(): IScheduler {
    return this.getScheduler();
  }

  localPortInUse(port: PortNumber, rawRemoteIp: string): boolean {
    const localIp = this.resolveEgress(canonicalIpText(rawRemoteIp))?.srcIp;
    for (const socket of this.sockets.values()) {
      if (socket.localPort === port.value && socket.localIp === localIp) return true;
    }
    for (const listener of this.listeners.values()) {
      if (listener.localPort === port.value && (listener.localIp === localIp || listener.localIp === '0.0.0.0')) return true;
    }
    return false;
  }

  connect(rawRemoteIp: string, remotePort: number, opts: TcpConnectOptions = {}): TcpSocket | null {
    if (!this.enabled) return null;
    const remoteIp = canonicalIpText(rawRemoteIp);
    const egress = this.resolveEgress(remoteIp);
    if (!egress) { this.dropped(remoteIp, remotePort, 'no-egress'); return null; }
    const localIp = opts.localIp ?? egress.srcIp;
    if (opts.localPort && this.localPortInUse(opts.localPort, remoteIp)) {
      this.dropped(remoteIp, remotePort, 'addr-in-use');
      return null;
    }
    const localPort = opts.localPort?.value ?? this.nextEphemeral(localIp);
    if (localPort === -1) {
      this.dropped(remoteIp, remotePort, 'no-ephemeral');
      return null;
    }
    const socket = new TcpSocket(this, localIp, localPort, remoteIp, remotePort);
    if (opts.onOpen) socket.onOpen(opts.onOpen);
    if (opts.onData) socket.onData(opts.onData);
    if (opts.onClose) socket.onClose(opts.onClose);
    socket.ttl = opts.ttl ?? null;
    socket.diffServ = opts.diffServ ?? DiffServField.DEFAULT;
    socket.passive = false;
    socket.mss = mssForMtu(socket.family, this.egressMtu(egress));
    socket.sendNext = this.initialSequence(socket);
    socket.sendUnacked = socket.sendNext;
    this.sockets.set(socket.key(), socket);
    this._transition(socket, 'syn-sent');
    const flags = noFlags(); flags.syn = true;
    const synSeq = socket.sendNext;
    socket.sendNext = (socket.sendNext + 1) >>> 0;
    // PRD-TCP.md P6 — offer our real capabilities on the SYN itself; the
    // peer's SYN-ACK tells us which ones it actually supports.
    const synOptions = encodeOptions({
      mss: socket.mss, windowScale: socket.windowScale, sackPermitted: true,
      timestamp: { tsVal: Math.floor(this.getScheduler().now()), tsEcr: 0 },
    });
    this.transmitTracked(socket, flags, synSeq, 0, undefined, 1, synOptions);
    return socket;
  }

  /**
   * Synchronous connect probe whose result is derived entirely from the
   * wire: 'open' on an established handshake, 'refused' when the peer
   * answers with a RST or an ICMP unreachable (host firewall REJECT / no
   * listener), 'timeout' when nothing comes back (silent DROP), and
   * 'unreachable' when the attempt never left this machine because no
   * route resolves — ENETUNREACH, which a real stack reports at once.
   */
  connectOutcome(
    remoteIp: string, remotePort: number, localPort?: PortNumber, localIp?: string,
  ): TcpWireOutcome {
    return this.exchange(remoteIp, remotePort, '', { localPort, localIp }).outcome;
  }

  /**
   * nmap's `Probe TCP NULL q||`, and what `nc host port` prints: open the
   * connection, send nothing, read what the service volunteers, close.
   * `onData` replays the bytes that arrived before the handler existed —
   * the greeting is written while the handshake completes — so the answer
   * comes from the wire and never from the peer's object.
   */
  grabGreeting(remoteIp: string, remotePort: number): string | null {
    return this.probeService(remoteIp, remotePort, '');
  }

  probeService(remoteIp: string, remotePort: number, payload: string): string | null {
    const { received } = this.exchange(remoteIp, remotePort, payload);
    return received === '' ? null : received;
  }

  exchange(
    remoteIp: string, remotePort: number, payload: string,
    opts: { localPort?: PortNumber; localIp?: string } = {},
  ): { outcome: TcpWireOutcome; received: string } {
    const socket = this.connect(remoteIp, remotePort, {
      ...(opts.localPort === undefined ? {} : { localPort: opts.localPort }),
      ...(opts.localIp === undefined ? {} : { localIp: opts.localIp }),
    });
    if (!socket) return { outcome: this.hasEgressTo(remoteIp) ? 'timeout' : 'unreachable', received: '' };
    if (!socket.everEstablished) {
      const outcome = socket.connectProhibited ? 'prohibited' : socket.connectRefused ? 'refused' : 'timeout';
      socket.close();
      return { outcome, received: '' };
    }
    let received = '';
    const stop = socket.onData((chunk) => {
      if (typeof chunk === 'string') received += chunk;
      else if (chunk instanceof Uint8Array) received += new TextDecoder().decode(chunk);
    });
    if (payload.length > 0) socket.write(payload);
    stop();
    socket.close();
    return { outcome: 'open', received };
  }

  /**
   * Un segment emis HORS de toute connexion, et la reponse observee la ou
   * une socket l'aurait recue. C'est ce que font TOUS les balayages de
   * `nmap` qui n'ouvrent rien — SYN, ACK, FIN, NULL, Xmas, Maimon,
   * fenetre — et ce que `sendRst` fait deja dans l'autre sens : la pile
   * pose une trace le temps de l'aller-retour, sans rien ouvrir.
   *
   * Ce qui revient est rendu tel quel — un RST avec sa FENETRE, un
   * SYN/ACK, ou rien — parce que c'est la LECTURE de cette reponse qui
   * differe d'un balayage a l'autre, pas son emission.
   */
  scanProbe(
    remoteIp: string, remotePort: number, flags: TcpFlags,
    shape: ScanProbeShape = {},
  ): StatelessProbeReply {
    return this.scanProbeDetail(remoteIp, remotePort, flags, shape).reply;
  }

  /**
   * Le meme sondage, mais qui rend AUSSI la fenetre annoncee par la
   * reponse : `hping3` l'imprime (`waitpacket.c:389`, « win=%d »), la
   * collapser en « rst-window » suffisait a nmap et pas a lui.
   */
  scanProbeDetail(
    remoteIp: string, remotePort: number, flags: TcpFlags,
    shape: ScanProbeShape = {},
  ): StatelessProbeDetail {
    const target = canonicalIpText(remoteIp);
    const egress = this.resolveEgress(target, shape.iface);
    if (!egress) return emptyProbeDetail('none');
    const localPort = shape.sourcePort ?? this.nextEphemeral(egress.srcIp);
    if (localPort < 0) return emptyProbeDetail('none');

    // La trace est posee sur l'adresse REELLEMENT emise : une source
    // forgee ne peut recevoir aucune reponse, et la garder ici serait
    // pretendre en attendre une.
    const srcIp = shape.sourceIp === undefined
      ? egress.srcIp : canonicalIpText(shape.sourceIp);
    const key = makeSocketKey(srcIp, localPort, target, remotePort);
    const watch: StatelessProbeWatch = {
      seen: 'none', window: 0, flags: noFlags(),
      sequence: 0, acknowledgement: 0, checksum: 0, urgentPointer: 0,
      ip: { ...NO_REPLY_IP_HEADER },
      localPort, destIp: target, destPort: remotePort,
    };
    this.statelessProbes.set(key, watch);

    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: localPort, destinationPort: remotePort,
      sequence: shape.sequence ?? randomSequenceNumber(),
      acknowledgement: shape.acknowledgement ?? 0,
      dataOffset: 5, flags, window: shape.window ?? TCP_DEFAULT_WINDOW,
      checksum: 0, urgentPointer: 0, options: [], payload: shape.payload,
    };
    const sum = computeTcpChecksum(seg, srcIp, target);
    seg.checksum = shape.badChecksum ? bogusChecksum(sum, IP_PROTO_TCP) : sum;
    try {
      this.shipSegment(egress, srcIp, target, seg, shape);
    } finally {
      this.statelessProbes.delete(key);
    }
    const reply: StatelessProbeReply = watch.seen === 'rst'
      ? (watch.window > 0 ? 'rst-window' : 'rst')
      : watch.seen;
    return {
      reply, window: watch.window, flags: watch.flags,
      sequence: watch.sequence, acknowledgement: watch.acknowledgement,
      checksum: watch.checksum, urgentPointer: watch.urgentPointer,
      ...watch.ip,
      ...(watch.icmpType === undefined ? {} : { icmpType: watch.icmpType }),
      ...(watch.icmpCode === undefined ? {} : { icmpCode: watch.icmpCode }),
      ...(watch.icmpFrom === undefined ? {} : { icmpFrom: watch.icmpFrom }),
    };
  }

  private noteStatelessUnreachable(
    origSourcePort: number, origDestPort: number, origDestIp: string,
    icmpCode: number | undefined, icmpFrom?: string, icmpHeader?: ReceivedIpHeader,
  ): void {
    for (const watch of this.statelessProbes.values()) {
      if (watch.localPort !== origSourcePort) continue;
      if (watch.destPort !== origDestPort) continue;
      if (watch.destIp !== origDestIp) continue;
      watch.seen = icmpCode !== undefined && PROHIBITED_UNREACH_CODES.has(icmpCode)
        ? 'icmp-prohibited'
        : 'icmp-unreachable';
      watch.icmpType = ICMP_TYPE_DEST_UNREACH;
      watch.icmpCode = icmpCode;
      watch.icmpFrom = icmpFrom;
      if (icmpHeader) watch.ip = { ...icmpHeader };
      return;
    }
  }

  noteProbeTimeExceeded(
    origSourcePort: number, origDestPort: number, origDestIp: string,
    icmpCode: number, icmpFrom: string, icmpHeader?: ReceivedIpHeader,
  ): void {
    for (const watch of this.statelessProbes.values()) {
      if (watch.localPort !== origSourcePort) continue;
      if (watch.destPort !== origDestPort) continue;
      if (watch.destIp !== origDestIp) continue;
      watch.seen = 'icmp-unreachable';
      watch.icmpType = ICMP_TYPE_TIME_EXCEEDED;
      watch.icmpCode = icmpCode;
      watch.icmpFrom = icmpFrom;
      if (icmpHeader) watch.ip = { ...icmpHeader };
      return;
    }
  }

  private statelessProbes = new Map<string, StatelessProbeWatch>();

  hasEgressTo(remoteIp: string): boolean {
    return this.resolveEgress(canonicalIpText(remoteIp)) !== null;
  }

  /**
   * An ICMP destination-unreachable carrying one of our outbound TCP
   * segments: fail the matching connection (RFC 1122 §4.2.3.9 — a hard
   * error aborts the connection attempt on a SYN, and is a fatal error
   * on an already-open connection too — e.g. the peer's firewall starts
   * rejecting mid-session).
   */
  onIcmpUnreachable(
    origSourcePort: number, origDestPort: number, origDestIp: string,
    icmpCode?: number, icmpFrom?: string, icmpHeader?: ReceivedIpHeader,
  ): void {
    for (const socket of this.sockets.values()) {
      if (socket.localPort !== origSourcePort) continue;
      if (socket.remotePort !== origDestPort) continue;
      if (socket.remoteIp !== origDestIp) continue;
      if (socket.state === 'closed' || socket.state === 'time-wait') continue;
      if (icmpCode !== undefined && PROHIBITED_UNREACH_CODES.has(icmpCode)) {
        socket.connectProhibited = true;
      }
      socket.connectRefused = true;
      this._teardown(socket, 'rst');
      return;
    }
    this.noteStatelessUnreachable(
      origSourcePort, origDestPort, origDestIp, icmpCode, icmpFrom, icmpHeader);
  }

  /**
   * Minimal Path MTU Discovery (PRD-TCP.md P7, RFC 1191/1981): unlike a
   * generic unreachable, an ICMP "Fragmentation Needed"/"Packet Too Big"
   * is not a hard error — the path is fine, our segment was just too big
   * for it. Shrink MSS to fit the reported next-hop MTU and re-send the
   * data that bounced, instead of tearing the connection down.
   */
  onIcmpFragNeeded(
    origSourcePort: number, origDestPort: number, origDestIp: string,
    origSequence: number, nextHopMtu: number,
  ): void {
    for (const socket of this.sockets.values()) {
      if (socket.localPort !== origSourcePort) continue;
      if (socket.remotePort !== origDestPort) continue;
      if (socket.remoteIp !== origDestIp) continue;
      if (socket.state === 'closed' || socket.state === 'time-wait') continue;
      // A plain outgoing data segment carries a timestamp option whenever
      // negotiated (see `transmit()`) — omitting its bytes here would
      // under-estimate the real on-wire size, computing a "corrected" MSS
      // that's still too big and bounces off the very same hop forever
      // (the guard below then blocks ever retrying the same value again).
      const newMss = Math.max(TCP_MIN_MSS, mssForMtu(socket.family, nextHopMtu));
      // Never grow MSS off this signal, but still attempt resegmentation
      // even when it doesn't need to shrink further: an already-queued
      // segment chunked at an *earlier*, larger MSS (before a previous
      // bounce corrected it) can still be individually oversized even
      // though the running `socket.mss` value is already correct.
      if (newMss < socket.mss) {
        socket.cc.setSegmentSize(newMss);
        socket.mss = newMss;
      }
      this.resegmentAndRetransmit(socket, origSequence);
      return;
    }
  }

  /**
   * The segment that just bounced off a smaller-MTU hop is sitting,
   * already-sent, at the head of `unackedQueue` — at its old, now too-big
   * size. Because this fires synchronously from deep inside that very
   * segment's own `transmit()` call (this simulator delivers frames —
   * and therefore ICMP bounces — inline), `unackedQueue[0]` is guaranteed
   * to still be that exact segment; anything already further along would
   * only be true for a second, independent in-flight segment, which this
   * minimal implementation deliberately leaves for the normal RTO path
   * rather than attempting general reordering.
   *
   * Re-chunks the bounced payload by the *new*, smaller MSS and hands it
   * back to the normal backlog path — resending the same oversized bytes
   * verbatim would just hit the identical MTU wall again next RTO.
   */
  private resegmentAndRetransmit(socket: TcpSocket, origSequence: number): void {
    const head = socket.unackedQueue[0];
    if (!head || head.sequence !== origSequence) return;
    if (!isStreamPayload(head.payload) || head.length <= this.sendMss(socket)) return;
    const bounced = head.payload;
    socket.unackedQueue.shift();
    socket.sendNext = head.sequence;
    const resegmented: Array<{ payload: StreamPayload; psh: boolean }> = [];
    let offset = 0;
    while (offset < bounced.length) {
      const chunk = sliceStream(bounced, offset, offset + this.sendMss(socket));
      offset += chunk.length;
      resegmented.push({ payload: chunk, psh: head.flags.psh && offset >= bounced.length });
    }
    socket.sendBacklog.unshift(...resegmented);
    this.flushSendBacklog(socket);
  }

  /**
   * Actively refuse an inbound segment the host firewall rejected: reply
   * with a RST as a real host does for `-j REJECT --reject-with tcp-reset`,
   * so the peer's connect settles as 'refused' rather than timing out.
   */
  sendResetForSegment(localIp: string, senderIp: string, seg: TcpSegment): void {
    if (seg.flags.rst) return;
    this.sendRst(localIp, senderIp, seg);
  }

  private externalPortClaim: ((port: number) => boolean) | null = null;
  setExternalPortClaim(predicate: ((port: number) => boolean) | null): void {
    this.externalPortClaim = predicate;
  }

  hasInterest(ipPkt: IPv4Packet, srcIp: IPAddress): boolean {
    if (!this.enabled) return false;
    if (ipPkt.protocol !== IP_PROTO_TCP) return false;
    const seg = ipPkt.payload as TcpSegment | undefined;
    if (!seg || seg.type !== 'tcp') return false;
    const dstIp = ipPkt.destinationIP.toString();
    const senderIp = srcIp.toString();
    const socketKey = makeSocketKey(dstIp, seg.destinationPort, senderIp, seg.sourcePort);
    if (this.sockets.has(socketKey)) return true;
    if (this.findListener(dstIp, seg.destinationPort)) return true;
    if (this.externalPortClaim && this.externalPortClaim(seg.destinationPort)) return false;
    if (seg.flags.syn && !seg.flags.ack) return true;
    return false;
  }

  handleIp(_inPort: string, srcIp: IPAddress, ipPkt: IPv4Packet): boolean {
    if (!this.enabled) return false;
    if (ipPkt.protocol !== IP_PROTO_TCP) return false;
    const seg = ipPkt.payload as TcpSegment | undefined;
    if (!seg || seg.type !== 'tcp') return false;
    const refusal = this.wireRefusal4(srcIp, ipPkt.destinationIP);
    if (refusal !== null) {
      this.dropped(srcIp.toString(), seg.sourcePort, refusal);
      return true;
    }
    return this.handleSegment(
      srcIp.toString(), ipPkt.destinationIP.toString(), seg, receivedIpHeaderOf(ipPkt));
  }

  handleIp6(_inPort: string, srcIp: IPv6Address, ipv6: IPv6Packet): boolean {
    if (!this.enabled) return false;
    if (ipv6.nextHeader !== IP_PROTO_TCP) return false;
    const seg = ipv6.payload as TcpSegment | undefined;
    if (!seg || seg.type !== 'tcp') return false;
    if (ipv6.destinationIP.isMulticast()) {
      this.dropped(srcIp.toString(), seg.sourcePort, 'non-unicast-destination');
      return true;
    }
    if (srcIp.isUnspecified() || srcIp.isMulticast() || srcIp.isLoopback()) {
      this.dropped(srcIp.toString(), seg.sourcePort, 'invalid-source');
      return true;
    }
    return this.handleSegment(srcIp.toString(), ipv6.destinationIP.toString(), seg);
  }

  private wireRefusal4(source: IPAddress, destination: IPAddress): TcpDropReason | null {
    const prefixes = this.connectedPrefixes();
    if (!isUnicastDestination(destination, prefixes)) return 'non-unicast-destination';
    if (invalidSourceFor(source, destination, prefixes) !== null) return 'invalid-source';
    if (this.isLocalDestination(source.toString(), 'ipv4')) return 'invalid-source';
    return null;
  }

  private handleSegment(
    senderIp: string, dstIp: string, seg: TcpSegment, ipHeader?: ReceivedIpHeader,
  ): boolean {
    // RFC 9293 §3.1 — a corrupted segment is discarded silently.
    if (!verifyTcpChecksum(seg, senderIp, dstIp)) {
      this.dropped(senderIp, seg.sourcePort, 'bad-checksum');
      return true;
    }

    const payloadSize = segmentPayloadSize(seg);
    this.getBus().publish({
      topic: 'tcp.segment.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: senderIp, destinationIp: dstIp,
        sourcePort: seg.sourcePort, destinationPort: seg.destinationPort,
        flagsText: flagsString(seg.flags),
        sequence: seg.sequence, acknowledgement: seg.acknowledgement,
        payloadSize,
      },
    });

    const socketKey = makeSocketKey(dstIp, seg.destinationPort, senderIp, seg.sourcePort);
    const existing = this.sockets.get(socketKey);
    if (existing && !this.yieldsToNewIncarnation(existing, seg)) {
      this._processSegment(existing, seg, payloadSize);
      return true;
    }
    if (seg.flags.syn && !seg.flags.ack) {
      const listener = this.findListener(dstIp, seg.destinationPort);
      if (!listener) {
        this.sendRst(dstIp, senderIp, seg);
        this.dropped(senderIp, seg.sourcePort, 'no-listener');
        return true;
      }
      const socket = new TcpSocket(this, dstIp, seg.destinationPort, senderIp, seg.sourcePort);
      socket.passive = true;
      socket.pendingListener = listener;
      socket.windowSize = listener.receiveWindow;
      socket.ttl = listener.ttl;
      socket.diffServ = listener.diffServ;
      const announcedMss = Math.min(
        mssForMtu(socket.family, this.egressMtu(this.resolveEgress(senderIp))), listener.maxSegmentSize);
      socket.recvNext = (seg.sequence + 1) >>> 0;
      socket.lastAckSent = socket.recvNext;
      socket.sendNext = this.initialSequence(socket);
      socket.sendUnacked = socket.sendNext;
      // PRD-TCP.md P6 — negotiate against whatever the peer's SYN offered.
      const peerOpts = interpretOptions(seg.options);
      socket.mss = Math.min(announcedMss, peerOpts.mss ?? defaultSendMss(socket.family));
      socket.peerWindowScale = peerOpts.windowScale ?? null;
      this.reportWindowScaleClamp(socket, seg);
      socket.sackEnabled = peerOpts.sackPermitted === true;
      if (peerOpts.timestamp) {
        socket.timestampsEnabled = true;
        socket.peerLastTsVal = peerOpts.timestamp.tsVal;
        socket.peerTsRecentAtMs = this.getScheduler().now();
      }
      this.sockets.set(socket.key(), socket);
      this._transition(socket, 'syn-received');
      const flags = noFlags(); flags.syn = true; flags.ack = true;
      // Allocate the sequence BEFORE transmitting: Cable delivery is
      // synchronous, so the peer's reply can re-enter this stack and
      // consume sendNext before the post-send increment would run.
      const synAckSeq = socket.sendNext;
      socket.sendNext = (socket.sendNext + 1) >>> 0;
      // Timestamp (if negotiated) is attached automatically by transmit()
      // below, since `socket.timestampsEnabled` is already set above —
      // including it here too would duplicate the option on the wire.
      const synAckOptions = encodeOptions({
        mss: announcedMss,
        windowScale: socket.peerWindowScale !== null ? socket.windowScale : undefined,
        sackPermitted: socket.sackEnabled || undefined,
      });
      this.transmitTracked(socket, flags, synAckSeq, socket.recvNext, undefined, 1, synAckOptions);
      return true;
    }
    const probe = this.statelessProbes.get(socketKey);
    const noteProbe = (verdict: StatelessProbeWatch['seen']): void => {
      if (!probe) return;
      probe.seen = verdict;
      probe.window = seg.window;
      probe.flags = { ...seg.flags };
      probe.sequence = seg.sequence;
      probe.acknowledgement = seg.acknowledgement;
      probe.checksum = seg.checksum;
      probe.urgentPointer = seg.urgentPointer;
      if (ipHeader) probe.ip = { ...ipHeader };
    };
    if (probe && seg.flags.syn && seg.flags.ack) noteProbe('syn-ack');
    if (seg.flags.rst) {
      noteProbe('rst');
      return true;
    }
    // RFC 9293 §3.10.7.2, etat LISTEN, quatrieme controle : un segment qui
    // n'est ni RST, ni ACK, ni SYN est JETE en silence par un port a
    // l'ecoute, alors qu'un port ferme repond RST (§3.10.7.1). Cette
    // asymetrie EST ce que mesurent les balayages FIN, NULL et Xmas.
    if (!seg.flags.ack && this.findListener(dstIp, seg.destinationPort)) {
      this.dropped(senderIp, seg.sourcePort, 'listen-ignores-segment');
      return true;
    }
    this.dropped(senderIp, seg.sourcePort, 'no-socket');
    this.sendRst(dstIp, senderIp, seg);
    return true;
  }

  _sendData(socket: TcpSocket, data: unknown): void {
    this.withinBurst(() => this.sendDataWithinBurst(socket, data));
  }

  /**
   * RFC 793 §3.7: "the urgent field is meaningful and must be added to the
   * segment sequence number to yield the urgent pointer", and RFC 9293 §3.1
   * places that pointer on "the sequence number of the octet following the
   * urgent data". SND.UP therefore lands one past the last urgent octet, and
   * `transmit` marks every segment still behind it.
   */
  _sendUrgentData(socket: TcpSocket, data: string): void {
    if (socket.closed || data.length === 0) return;
    const queued = socket.sendBacklog.reduce((n, e) => n + e.payload.length, 0);
    const point = (socket.sendNext + queued + data.length) >>> 0;
    socket.sndUp = socket.sndUp !== null && seqLt(point, socket.sndUp) ? socket.sndUp : point;
    this._sendData(socket, data);
  }

  private withinBurst(body: () => void): void {
    burstDepth++;
    try {
      body();
    } finally {
      burstDepth--;
      this.drainOwedAcks();
    }
  }

  private drainOwedAcks(): void {
    if (drainingAcks) return;
    drainingAcks = true;
    try {
      const due = (): TcpSocket[] => [...socketsOwingAck].filter((socket) => burstDepth === 0 || socket.openedAtBurstDepth >= burstDepth);
      for (let pending = due(); pending.length > 0; pending = due()) {
        for (const socket of pending) {
          socketsOwingAck.delete(socket);
          socket.stack.sendOwedAck(socket);
        }
      }
    } finally {
      drainingAcks = false;
    }
  }

  private sendDataWithinBurst(socket: TcpSocket, data: unknown): void {
    if (socket.closed) return;
    if (socket.state === 'syn-sent' || socket.state === 'syn-received') {
      socket.pendingSendQueue.push(data);
      return;
    }
    if (socket.state !== 'established' && socket.state !== 'close-wait') return;

    if (!isStreamPayload(data)) {
      const flags = noFlags(); flags.ack = true; flags.psh = true;
      const seq = socket.sendNext;
      socket.sendNext = (seq + OPAQUE_PAYLOAD_SEQUENCE_UNITS) >>> 0;
      this.transmitTracked(socket, flags, seq, socket.recvNext, data, OPAQUE_PAYLOAD_SEQUENCE_UNITS);
      return;
    }

    if (data.length === 0) {
      socket.sendBacklog.push({ payload: sliceStream(data, 0, 0), psh: true });
    } else {
      let offset = 0;
      while (offset < data.length) {
        const chunk = sliceStream(data, offset, offset + this.sendMss(socket));
        offset += chunk.length;
        this.queueForSend(socket, chunk, offset >= data.length);
      }
    }
    this.flushSendBacklog(socket);
  }

  /**
   * RFC 896 / RFC 9293 §3.7.4 — Nagle is a COALESCING algorithm, not
   * merely a delaying one: what it holds back it must also glue to
   * whatever the application writes next, or it turns one small segment
   * into two. A write lands on the tail of `sendBacklog` while that tail
   * is still short of a full segment, so consecutive small writes that
   * never made it onto the wire become one segment rather than a queue of
   * runts. Only the tail is touched, so a remainder that `flushSendBacklog`
   * or `resegmentAndRetransmit` pushed back onto the FRONT keeps its place
   * in the stream.
   */
  private sendMss(socket: TcpSocket): number {
    const dataSegmentOptions: TcpOption[] = socket.timestampsEnabled
      ? [{ kind: 'timestamp', tsVal: 0, tsEcr: 0 }] : [];
    return socket.mss - (optionsDataOffset(dataSegmentOptions) * 4 - TCP_BASE_HEADER_BYTES);
  }

  private queueForSend(socket: TcpSocket, payload: StreamPayload, psh: boolean): void {
    let rest = payload;
    const tail = socket.sendBacklog[socket.sendBacklog.length - 1];
    const segmentBytes = this.sendMss(socket);
    if (tail && tail.payload.length < segmentBytes) {
      const room = segmentBytes - tail.payload.length;
      const merged = sliceStream(rest, 0, room);
      tail.payload = appendStream(tail.payload, merged);
      tail.psh = psh && merged.length === rest.length;
      rest = sliceStream(rest, merged.length);
    }
    if (rest.length === 0) return;
    socket.sendBacklog.push({ payload: rest, psh });
  }

  /**
   * Sends as much of `socket.sendBacklog` as the peer's advertised window
   * (PRD-TCP.md P3, RFC 9293 §3.8.6) currently allows, splitting a queued
   * chunk if only part of it fits. Whatever doesn't fit stays queued in
   * order until a future ACK/window-update frees enough room.
   */
  private limitedTransmit(socket: TcpSocket): void {
    socket.limitedTransmitCredits++;
    this.flushSendBacklog(socket);
  }

  private flushSendBacklog(socket: TcpSocket, overrideNagle = false): void {
    // Reentrant call (see `flushingBacklog`'s doc comment): the outer
    // invocation's `while` loop will pick up the freed window on its very
    // next iteration since the ACK that triggered this reentry already
    // updated `sendUnacked`/`cc.cwnd` before calling back in here — so
    // just return and let that loop keep going in its own stack frame
    // instead of nesting another one.
    if (socket.flushingBacklog) return;
    socket.flushingBacklog = true;
    socket.swsHeld = false;
    try {
      while (socket.sendBacklog.length > 0) {
        const inFlight = (socket.sendNext - socket.sendUnacked) >>> 0;
        const windowRoom = socket.peerWindow > inFlight ? socket.peerWindow - inFlight : 0;
        let congestionRoom = socket.cc.cwnd > inFlight ? socket.cc.cwnd - inFlight : 0;
        let spendsCredit = false;
        if (congestionRoom === 0 && socket.limitedTransmitCredits > 0) {
          const segment = this.sendMss(socket);
          const limit = socket.cc.cwnd + TCP_LIMITED_TRANSMIT_SLACK_SEGMENTS * segment;
          congestionRoom = limit > inFlight ? Math.min(segment, limit - inFlight) : 0;
          spendsCredit = congestionRoom > 0;
        }
        const available = Math.min(windowRoom, congestionRoom);
        if (available === 0) break;
        const next = socket.sendBacklog[0];
        const take = Math.min(available, next.payload.length);
        if (this.holdsForSillyWindow(socket, windowRoom, congestionRoom)) {
          socket.swsHeld = true;
          break;
        }
        if (this.nagleHolds(socket, next.payload.length, take, overrideNagle)) break;
        const chunk = sliceStream(next.payload, 0, take);
        const remainder = sliceStream(next.payload, take);
        socket.sendBacklog.shift();
        if (remainder.length > 0) {
          socket.sendBacklog.unshift({ payload: remainder, psh: next.psh });
        }
        const flags = noFlags(); flags.ack = true;
        if (next.psh && remainder.length === 0) flags.psh = true;
        const seq = socket.sendNext;
        this.restartAfterIdle(socket, inFlight);
        socket.sendNext = (seq + chunk.length) >>> 0;
        this.transmitTracked(socket, flags, seq, socket.recvNext, chunk, chunk.length);
        if (chunk.length === 0) break; // nothing consumed (zero window) — avoid spinning forever
        if (spendsCredit) {
          socket.limitedTransmitCredits--;
          socket.limitedTransmitBytes += chunk.length;
        }
      }
    } finally {
      socket.flushingBacklog = false;
      socket.limitedTransmitCredits = 0;
    }
    this.maybeArmPersistTimer(socket);
    const closePending = socket.closeAfterFlush
      && socket.sendBacklog.length === 0
      && (socket.state === 'established' || socket.state === 'close-wait');
    if (closePending) {
      socket.closeAfterFlush = false;
      this._initiateClose(socket);
    }
  }

  /**
   * RFC 9293 §3.7.4: "If there is unacknowledged data (i.e., SND.NXT >
   * SND.UNA), then the sending TCP endpoint buffers all user data
   * (regardless of the PSH bit) until the outstanding data has been
   * acknowledged or until the TCP endpoint can send a full-sized
   * segment."
   *
   * Two readings of "can send a full-sized segment" are possible and only
   * one is safe. Measured against the QUEUE and not against the window:
   * a receive window smaller than the MSS otherwise keeps every chunk
   * below full size forever, so the hold would never lift and a transfer
   * through a 128-byte window would deadlock outright. A window that
   * small is flow control's business (SWS avoidance) and the persist
   * timer's, never Nagle's. The empty write that carries only a PSH is
   * exempt: there is nothing to coalesce it with, and holding it would
   * simply lose the marker.
   */
  private restartAfterIdle(socket: TcpSocket, inFlight: number): void {
    if (inFlight > 0 || socket.lastDataSentAtMs === null) return;
    if (this.getScheduler().now() - socket.lastDataSentAtMs > socket.rtt.currentRto()) {
      socket.cc.restartAfterIdle();
    }
  }

  private holdsForSillyWindow(socket: TcpSocket, windowRoom: number, congestionRoom: number): boolean {
    if (socket.swsOverride || windowRoom >= congestionRoom) return false;
    let queued = 0;
    for (const entry of socket.sendBacklog) queued += entry.payload.length;
    if (queued <= windowRoom || windowRoom >= this.sendMss(socket)) return false;
    return windowRoom * 2 < socket.maxPeerWindow;
  }

  private nagleHolds(socket: TcpSocket, headLength: number, take: number, overrideNagle: boolean): boolean {
    if (overrideNagle || socket.noDelay) return false;
    const segmentBytes = this.sendMss(socket);
    if (headLength === 0 || take >= segmentBytes) return false;
    let queued = 0;
    for (const entry of socket.sendBacklog) queued += entry.payload.length;
    if (queued >= segmentBytes) return false;
    return seqLt(socket.sendUnacked, socket.sendNext);
  }

  _setNoDelay(socket: TcpSocket, enabled: boolean): void {
    socket.noDelay = enabled;
    if (enabled) this.withinBurst(() => this.flushSendBacklog(socket));
  }

  /** (Re)arm or disarm the zero-window persist-probe timer based on current window/backlog state. */
  private maybeArmPersistTimer(socket: TcpSocket): void {
    const stalled = socket.peerWindow === 0 || socket.swsHeld;
    if (!stalled || socket.sendBacklog.length === 0) {
      this.timers.clear(socket.persistTimer);
      socket.persistTimer = null;
      socket.persistBackoffMs = 0;
      return;
    }
    if (socket.persistTimer) return;
    if (socket.peerWindow > 0) {
      socket.persistTimer = this.timers.setTimeout(() => this.onPersistFired(socket), TCP_SWS_OVERRIDE_MS);
      return;
    }
    socket.persistBackoffMs = socket.persistBackoffMs > 0
      ? Math.min(socket.persistBackoffMs * 2, TCP_MAX_RTO_MS)
      : TCP_INITIAL_RTO_MS;
    socket.persistTimer = this.timers.setTimeout(() => this.onPersistFired(socket), socket.persistBackoffMs);
  }

  /**
   * RFC 9293 §3.8.6.1 — a closed window (`peerWindow === 0`) stalls
   * everything forever unless someone probes it: send exactly one byte of
   * real, already-queued data so the peer's ACK carries a fresh window
   * value even if it has nothing else to say.
   */
  private onPersistFired(socket: TcpSocket): void {
    this.withinBurst(() => this.persistProbeWithinBurst(socket));
  }

  private persistProbeWithinBurst(socket: TcpSocket): void {
    socket.persistTimer = null;
    if (socket.closed || socket.sendBacklog.length === 0) { socket.persistBackoffMs = 0; return; }
    if (socket.peerWindow > 0) {
      socket.swsOverride = true;
      try { this.flushSendBacklog(socket); } finally { socket.swsOverride = false; }
      return;
    }
    const next = socket.sendBacklog[0];
    if (next.payload.length === 0) { this.maybeArmPersistTimer(socket); return; }
    const probe = sliceStream(next.payload, 0, 1);
    const remainder = sliceStream(next.payload, 1);
    socket.sendBacklog.shift();
    if (remainder.length > 0) {
      socket.sendBacklog.unshift({ payload: remainder, psh: next.psh });
    }
    const flags = noFlags(); flags.ack = true;
    if (next.psh && remainder.length === 0) flags.psh = true;
    const seq = socket.sendNext;
    socket.sendNext = (seq + probe.length) >>> 0;
    this.transmitTracked(socket, flags, seq, socket.recvNext, probe, probe.length);
    this.maybeArmPersistTimer(socket);
  }

  private flushPendingSends(socket: TcpSocket): void {
    // `closeAfterFlush` must be honored even with nothing queued — a
    // `.close()` during `onAccept` (still 'syn-received', no data ever
    // written) used to return here before reaching the check
    // below, silently losing the close forever: the socket just stayed
    // open. That is exactly what a bidirectional relay's error path does
    // (closing the accepted side the instant the far side's connect is
    // refused, with nothing queued yet) — PRD-Port-Forwarding.md Phase 7's
    // portproxy relay surfaced this while testing a refused connect side.
    if (socket.pendingSendQueue.length > 0) {
      const queued = socket.pendingSendQueue.slice();
      socket.pendingSendQueue.length = 0;
      for (const data of queued) this._sendData(socket, data);
    }
    if (socket.closeAfterFlush) {
      socket.closeAfterFlush = false;
      this._initiateClose(socket);
    }
  }

  _initiateClose(socket: TcpSocket): void {
    if (socket.closed) return;
    // RFC 9293 §3.10.4, CLOSE Call / SYN-SENT STATE: "Delete the TCB and
    // return 'error: closing' responses to any queued SENDs, or RECEIVEs."
    // There is no connection to shut down gracefully — the handshake never
    // completed — so deferring the close until a flush that will never
    // happen just strands the socket, and its ephemeral port with it. A
    // caller that dials an unreachable peer and closes on failure (BGP's
    // `bgpConnect` does exactly that, on every convergence) used to leak
    // one port per attempt until the pool ran dry.
    if (socket.state === 'syn-sent') {
      this._teardown(socket, 'shutdown');
      return;
    }
    // 'syn-received' keeps the deferred close: the handshake is genuinely
    // in flight, and a `.close()` from inside `onAccept` must take effect
    // once it completes (see flushPendingSends).
    if (socket.state === 'syn-received') {
      socket.closeAfterFlush = true;
      return;
    }
    if (socket.state === 'established' || socket.state === 'close-wait') {
      this.flushSendBacklog(socket, true);
      if (socket.sendBacklog.length > 0) {
        socket.closeAfterFlush = true;
        return;
      }
    }
    if (socket.state === 'established') {
      this._transition(socket, 'fin-wait-1');
      const flags = noFlags(); flags.fin = true; flags.ack = true;
      const seq = socket.sendNext;
      socket.sendNext = (seq + 1) >>> 0;
      this.transmitTracked(socket, flags, seq, socket.recvNext, undefined, 1);
    } else if (socket.state === 'close-wait') {
      this._transition(socket, 'last-ack');
      const flags = noFlags(); flags.fin = true; flags.ack = true;
      const seq = socket.sendNext;
      socket.sendNext = (seq + 1) >>> 0;
      this.transmitTracked(socket, flags, seq, socket.recvNext, undefined, 1);
    } else {
      this._teardown(socket, 'shutdown');
    }
  }

  private _processReset(socket: TcpSocket, seg: TcpSegment): void {
    if (seg.sequence === socket.recvNext) {
      if (socket.state === 'syn-received') socket.connectRefused = true;
      this._teardown(socket, 'rst');
      return;
    }
    this.sendChallengeAck(socket);
  }

  private _processSegment(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    socket.lastHeardAtMs = this.getScheduler().now();
    if (socket.state === 'syn-sent') this.arriveInSynSent(socket, seg, payloadSize);
    else this.arriveSynchronized(socket, seg, payloadSize);
    if (socket.keepAliveEnabled && socket.state === 'established') {
      socket.keepAliveProbesSent = 0;
      this.rearmKeepAliveTimer(socket);
    }
  }

  private egressMtu(egress: { name: string; port?: import('../hardware/Port').Port } | null): number {
    if (egress?.port) return egress.port.getMTU();
    return egress?.name === 'lo' ? LOOPBACK_MTU : DEFAULT_ETHERNET_MTU;
  }

  private initialSequence(socket: TcpSocket): number {
    const generated = this.isn.next(
      this.getScheduler().now(), socket.localIp, socket.localPort, socket.remoteIp, socket.remotePort);
    const floor = this.incarnationFloors.get(socket.key());
    if (floor === undefined) return generated;
    this.incarnationFloors.delete(socket.key());
    return seqLt(generated, floor) ? floor : generated;
  }

  private yieldsToNewIncarnation(socket: TcpSocket, seg: TcpSegment): boolean {
    if (socket.state !== 'time-wait' || !seg.flags.syn || seg.flags.ack || seg.flags.rst) return false;
    if (!seqLt(socket.recvNext, seg.sequence)) return false;
    if (!this.findListener(socket.localIp, socket.localPort)) return false;
    this.incarnationFloors.set(socket.key(), socket.sendNext);
    this._teardown(socket, 'fin');
    return true;
  }

  private acknowledgesOurSyn(socket: TcpSocket, ack: number): boolean {
    return seqLt(socket.sendUnacked, ack) && !seqLt(socket.sendNext, ack);
  }

  private ourFinAcknowledged(socket: TcpSocket): boolean {
    return !seqLt(socket.sendUnacked, socket.sendNext);
  }

  private sendAckNow(socket: TcpSocket): void {
    const flags = noFlags(); flags.ack = true;
    this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
  }

  private sendChallengeAck(socket: TcpSocket): void {
    if (!this.challengeAcks.tryAcquire(this.getScheduler().now())) return;
    this.sendAckNow(socket);
  }

  setChallengeAckThrottle(limit: number, windowMs: number): void {
    this.challengeAcks.configure(limit, windowMs);
  }

  private arriveInSynSent(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    const acknowledgesSyn = seg.flags.ack && this.acknowledgesOurSyn(socket, seg.acknowledgement);
    if (seg.flags.ack && !acknowledgesSyn) {
      if (!seg.flags.rst) this.sendRst(socket.localIp, socket.remoteIp, seg);
      return;
    }
    if (seg.flags.rst) {
      if (!acknowledgesSyn) {
        this.dropped(socket.remoteIp, socket.remotePort, 'bad-state');
        return;
      }
      socket.connectRefused = true;
      this._teardown(socket, 'rst');
      return;
    }
    if (!seg.flags.syn) {
      this.dropped(socket.remoteIp, socket.remotePort, 'bad-state');
      return;
    }
    const options = interpretOptions(seg.options);
    socket.recvNext = (seg.sequence + 1) >>> 0;
    socket.lastAckSent = socket.recvNext;
    socket.peerWindow = seg.window;
    socket.maxPeerWindow = Math.max(socket.maxPeerWindow, socket.peerWindow);
    socket.sendWl1 = seg.sequence;
    socket.sendWl2 = seg.acknowledgement;
    socket.mss = Math.min(socket.mss, options.mss ?? defaultSendMss(socket.family));
    socket.peerWindowScale = options.windowScale ?? null;
    this.reportWindowScaleClamp(socket, seg);
    socket.sackEnabled = options.sackPermitted === true;
    socket.timestampsEnabled = options.timestamp !== undefined;
    if (options.timestamp) {
      socket.peerLastTsVal = options.timestamp.tsVal;
      socket.peerTsRecentAtMs = this.getScheduler().now();
    }
    if (!acknowledgesSyn) {
      const head = socket.unackedQueue[0];
      if (head) head.flags = { ...head.flags, ack: true };
      const synAckFlags = noFlags(); synAckFlags.syn = true; synAckFlags.ack = true;
      this.transmit(socket, synAckFlags, socket.sendUnacked, socket.recvNext, undefined);
      this._transition(socket, 'syn-received');
      return;
    }
    const synRetransmitted = (socket.unackedQueue[0]?.retransmitCount ?? 0) > 0;
    this.pruneUnackedQueue(socket, seg.acknowledgement, options.timestamp?.tsEcr);
    if (synRetransmitted) socket.rtt.holdAtLeast(TCP_RTO_AFTER_SYN_RETRANSMIT_MS);
    socket.cc.initialize(socket.mss, synRetransmitted);
    this._transition(socket, 'established');
    this.sendAckNow(socket);
    this.emitOpened(socket);
    try { socket._fireOpen(); } catch (e) { Logger.warn(this.host.id, 'tcp:onOpen', String(e)); }
    this.flushPendingSends(socket);
    if (payloadSize > 0 || seg.flags.fin) {
      this.processText(socket, { ...seg, sequence: socket.recvNext }, payloadSize);
    }
  }

  private reportWindowScaleClamp(socket: TcpSocket, seg: TcpSegment): void {
    const offered = decodeOptions(seg.options).windowScale;
    if (offered === undefined || offered <= TCP_MAX_WINDOW_SCALE) return;
    Logger.warn(
      this.host.id, 'tcp:window-scale',
      `${socket.remoteIp}:${socket.remotePort} offered shift.cnt ${offered}, using ${TCP_MAX_WINDOW_SCALE}`,
    );
  }

  private arriveSynchronized(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    const options = interpretOptions(seg.options);
    const length = payloadSize + (seg.flags.syn ? 1 : 0) + (seg.flags.fin ? 1 : 0);

    if (this.failsPaws(socket, seg, options)) {
      this.sendAckNow(socket);
      return;
    }
    if (!this.sequenceAcceptable(socket, seg.sequence, length)) {
      this.answerUnacceptable(socket, seg, length);
      return;
    }
    this.recordTimestamp(socket, seg, options);
    if (seg.flags.rst) {
      this._processReset(socket, seg);
      return;
    }
    if (seg.flags.syn) {
      this.answerSynInSynchronizedState(socket);
      return;
    }
    if (!seg.flags.ack) {
      this.dropped(socket.remoteIp, socket.remotePort, 'bad-state');
      return;
    }
    if (!this.processAckField(socket, seg, options, payloadSize)) return;
    this.processText(socket, seg, payloadSize);
  }

  private sequenceAcceptable(socket: TcpSocket, sequence: number, length: number): boolean {
    const window = this.heldWindow(socket);
    const first = (sequence - socket.recvNext) >>> 0;
    if (length === 0) return window === 0 ? first === 0 : first < window;
    if (window === 0) return false;
    const last = (sequence + length - 1 - socket.recvNext) >>> 0;
    return first < window || last < window;
  }

  private answerUnacceptable(socket: TcpSocket, seg: TcpSegment, length: number): void {
    if (seg.flags.rst) return;
    if (socket.state === 'time-wait' && seg.flags.fin) this.restartTimeWait(socket);
    if (length === 0 && !this.mayAnswerPureAck(socket)) return;
    this.sendAckNow(socket);
  }

  private mayAnswerPureAck(socket: TcpSocket): boolean {
    const now = this.getScheduler().now();
    if (socket.lastOutOfWindowAckAt !== null
      && now - socket.lastOutOfWindowAckAt < TCP_INVALID_ACK_RATELIMIT_MS) return false;
    socket.lastOutOfWindowAckAt = now;
    return true;
  }

  private answerSynInSynchronizedState(socket: TcpSocket): void {
    if (socket.state === 'syn-received' && socket.passive) {
      this._teardown(socket, 'rst');
      return;
    }
    this.sendChallengeAck(socket);
  }

  private failsPaws(socket: TcpSocket, seg: TcpSegment, options: TcpOptionsSet): boolean {
    const stamp = options.timestamp;
    if (!stamp || !socket.timestampsEnabled || seg.flags.rst) return false;
    const recent = socket.peerLastTsVal;
    if (recent === null) return false;
    if (this.getScheduler().now() - socket.peerTsRecentAtMs >= TCP_TS_RECENT_VALID_MS) return false;
    return seqLt(stamp.tsVal, recent);
  }

  private recordTimestamp(socket: TcpSocket, seg: TcpSegment, options: TcpOptionsSet): void {
    const stamp = options.timestamp;
    if (!stamp || !socket.timestampsEnabled) return;
    const recent = socket.peerLastTsVal;
    if (recent !== null && seqLt(stamp.tsVal, recent)) return;
    if (seqLt(socket.lastAckSent, seg.sequence)) return;
    socket.peerLastTsVal = stamp.tsVal;
    socket.peerTsRecentAtMs = this.getScheduler().now();
  }

  private processAckField(
    socket: TcpSocket, seg: TcpSegment, options: TcpOptionsSet, payloadSize: number,
  ): boolean {
    if (socket.state === 'syn-received') return this.completeHandshake(socket, seg, options);
    const ack = seg.acknowledgement;
    if (seqLt(socket.sendNext, ack) || seqLt(ack, (socket.sendUnacked - socket.maxPeerWindow) >>> 0)) {
      this.sendChallengeAck(socket);
      return false;
    }
    const learnedSack = options.sackBlocks !== undefined
      && socket.sackScoreboard.record(options.sackBlocks, socket.sendUnacked, socket.sendNext);
    const isDuplicateAck = payloadSize === 0 && !seg.flags.fin && !seg.flags.syn
      && ack === socket.sendUnacked && socket.unackedQueue.length > 0
      && this.decodeWindowField(socket, seg) === socket.peerWindow;
    if (isDuplicateAck) {
      const flightSize = ((socket.sendNext - socket.sendUnacked) - socket.limitedTransmitBytes) >>> 0;
      if (socket.cc.onDuplicateAck(flightSize)) {
        socket.limitedTransmitBytes = 0;
        this.fastRetransmit(socket);
      }
      else if (socket.cc.duplicateAcks <= TCP_LIMITED_TRANSMIT_ACKS && (!socket.sackEnabled || learnedSack)) {
        this.limitedTransmit(socket);
      }
    } else {
      const ackedBytes = this.pruneUnackedQueue(socket, ack, options.timestamp?.tsEcr);
      if (ackedBytes > 0) {
        socket.cc.onNewAck(ackedBytes);
        socket.limitedTransmitBytes = 0;
        socket.sackScoreboard.advance(socket.sendUnacked);
      }
    }
    this.updateSendWindow(socket, seg);
    this.flushSendBacklog(socket);
    switch (socket.state) {
      case 'fin-wait-1':
        if (this.ourFinAcknowledged(socket)) this._transition(socket, 'fin-wait-2');
        return true;
      case 'closing':
        if (this.ourFinAcknowledged(socket)) this.enterTimeWait(socket);
        return false;
      case 'last-ack':
        if (this.ourFinAcknowledged(socket)) this._teardown(socket, 'fin');
        return false;
      default:
        return true;
    }
  }

  private completeHandshake(socket: TcpSocket, seg: TcpSegment, options: TcpOptionsSet): boolean {
    if (!this.acknowledgesOurSyn(socket, seg.acknowledgement)) {
      this.sendRst(socket.localIp, socket.remoteIp, seg);
      return false;
    }
    const synAckRetransmitted = (socket.unackedQueue[0]?.retransmitCount ?? 0) > 0;
    this.pruneUnackedQueue(socket, seg.acknowledgement, options.timestamp?.tsEcr);
    if (synAckRetransmitted) socket.rtt.holdAtLeast(TCP_RTO_AFTER_SYN_RETRANSMIT_MS);
    socket.peerWindow = this.decodeWindowField(socket, seg);
    socket.maxPeerWindow = Math.max(socket.maxPeerWindow, socket.peerWindow);
    socket.sendWl1 = seg.sequence;
    socket.sendWl2 = seg.acknowledgement;
    socket.cc.initialize(socket.mss, synAckRetransmitted);
    this._transition(socket, 'established');
    this.emitOpened(socket);
    this.completePassiveOpen(socket);
    try { socket._fireOpen(); } catch (e) { Logger.warn(this.host.id, 'tcp:onOpen', String(e)); }
    this.flushPendingSends(socket);
    return true;
  }

  private completePassiveOpen(socket: TcpSocket): void {
    const listener = socket.pendingListener;
    if (!listener) return;
    socket.pendingListener = null;
    if (listener.identity.banner) socket.write(listener.identity.banner);
    try { listener.onAccept(socket); } catch (e) { Logger.warn(this.host.id, 'tcp:accept', String(e)); }
  }

  private updateSendWindow(socket: TcpSocket, seg: TcpSegment): void {
    const ack = seg.acknowledgement;
    if (seqLt(ack, socket.sendUnacked) || seqLt(socket.sendNext, ack)) return;
    const fresher = seqLt(socket.sendWl1, seg.sequence)
      || (socket.sendWl1 === seg.sequence && !seqLt(ack, socket.sendWl2));
    if (!fresher) return;
    socket.peerWindow = this.decodeWindowField(socket, seg);
    socket.maxPeerWindow = Math.max(socket.maxPeerWindow, socket.peerWindow);
    socket.sendWl1 = seg.sequence;
    socket.sendWl2 = ack;
  }

  private processText(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    const state = socket.state;
    if (state !== 'established' && state !== 'fin-wait-1' && state !== 'fin-wait-2') return;
    const window = this.heldWindow(socket);
    const skip = seqLt(seg.sequence, socket.recvNext) ? (socket.recvNext - seg.sequence) >>> 0 : 0;
    const textStart = (seg.sequence + skip) >>> 0;
    const room = (socket.recvNext + window - textStart) >>> 0;
    const payload = seg.payload;
    let data: StreamPayload | undefined;
    let opaque = false;
    let cutAtWindowEdge = false;
    if (payloadSize > 0) {
      if (isStreamPayload(payload)) {
        const wanted = payloadSize - skip;
        const usable = Math.min(wanted, room);
        cutAtWindowEdge = usable < wanted;
        if (usable > 0) data = sliceStream(payload, skip, skip + usable);
      } else {
        opaque = skip === 0;
      }
    }
    const dataLength = data !== undefined ? data.length : opaque ? OPAQUE_PAYLOAD_SEQUENCE_UNITS : 0;
    const finSequence = (seg.sequence + payloadSize) >>> 0;
    const finInWindow = ((finSequence - socket.recvNext) >>> 0) < window;
    const finPresent = seg.flags.fin && !cutAtWindowEdge && finInWindow;
    const inOrder = textStart === socket.recvNext;
    let answered = false;

    if (dataLength > 0 && inOrder) {
      const fillsAGap = socket.reassemblyBuffer.length > 0;
      if (skip === 0) this.noteUrgentPoint(socket, seg);
      this.deliverText(socket, data ?? payload, dataLength, seg.flags.psh);
      if (!finPresent) this.acknowledgeReceivedData(socket, fillsAGap);
    } else if (dataLength > 0) {
      if (data !== undefined) {
        socket.reassemblyBuffer.insert(textStart, data, seg.flags.psh, TCP_REASSEMBLY_MAX_BYTES);
      }
      this.sendAckNow(socket);
      answered = true;
    }

    if (finPresent && finSequence === socket.recvNext) {
      this.processFin(socket);
    } else if (finPresent) {
      socket.reassemblyBuffer.holdFin(finSequence);
      if (!answered) this.sendAckNow(socket);
    } else {
      this.resolveHeldFin(socket);
    }
  }

  private resolveHeldFin(socket: TcpSocket): void {
    const held = socket.reassemblyBuffer.finSequence;
    if (held !== null && held === socket.recvNext) this.processFin(socket);
  }

  /**
   * RFC 793 §3.7 adds SEG.UP to the segment's sequence number to yield the
   * urgent point; RFC 9293 §3.8.5 keeps the receiver in urgent mode while
   * that point is in advance of RCV.NXT. RFC 6093 §3.1 settles what the
   * application is handed: "the last byte of 'urgent data' is delivered
   * 'out of band'".
   *
   * The byte is ALSO left in the ordinary stream — the behaviour a real
   * socket gets with SO_OOBINLINE. Removing it would make the octet count
   * the application reads disagree with the one countable on the wire, and
   * two views of one transfer that contradict each other is the defect this
   * repository refuses first.
   */
  private noteUrgentPoint(socket: TcpSocket, seg: TcpSegment): void {
    if (!seg.flags.urg || seg.urgentPointer <= 0) return;
    const point = (seg.sequence + seg.urgentPointer) >>> 0;
    if (socket.rcvUp === null || seqLt(socket.rcvUp, point)) socket.rcvUp = point;
    if (!isStreamPayload(seg.payload)) return;
    const offset = (point - 1 - seg.sequence) | 0;
    if (offset < 0 || offset >= seg.payload.length) return;
    const lastUrgentByte = String(sliceStream(seg.payload, offset, offset + 1));
    try { socket._fireUrgent(lastUrgentByte); }
    catch (e) { Logger.warn(this.host.id, 'tcp:onUrgent', String(e)); }
  }

  private acknowledgeReceivedData(socket: TcpSocket, fillsAGap: boolean): void {
    socket.segmentsSinceAck++;
    if (fillsAGap || socket.segmentsSinceAck >= TCP_ACK_EVERY_N_SEGMENTS) {
      this.sendOwedAck(socket);
      return;
    }
    socketsOwingAck.add(socket);
    if (socket.delayedAckTimer) return;
    socket.delayedAckTimer = this.timers.setTimeout(() => {
      socket.delayedAckTimer = null;
      this.sendOwedAck(socket);
    }, TCP_DELAYED_ACK_MS);
  }

  private sendOwedAck(socket: TcpSocket): void {
    const stillOurs = this.sockets.get(socket.key()) === socket;
    if (socket.segmentsSinceAck === 0 || socket.closed || !stillOurs) {
      this.forgetOwedAck(socket);
      return;
    }
    this.sendAckNow(socket);
  }

  private forgetOwedAck(socket: TcpSocket): void {
    socket.segmentsSinceAck = 0;
    socketsOwingAck.delete(socket);
    if (!socket.delayedAckTimer) return;
    this.timers.clear(socket.delayedAckTimer);
    socket.delayedAckTimer = null;
  }

  private enterTimeWait(socket: TcpSocket): void {
    if (socket.state === 'time-wait') return;
    this._transition(socket, 'time-wait');
    this.timers.clear(socket.rtoTimer);
    socket.rtoTimer = null;
    this.timers.clear(socket.persistTimer);
    socket.persistTimer = null;
    this.timers.clear(socket.keepAliveTimer);
    socket.keepAliveTimer = null;
    this.restartTimeWait(socket);
  }

  private restartTimeWait(socket: TcpSocket): void {
    this.timers.clear(socket.timeWaitTimer);
    socket.timeWaitTimer = this.timers.setTimeout(() => {
      socket.timeWaitTimer = null;
      this._teardown(socket, 'fin');
    }, TCP_TIME_WAIT_MS);
  }

  private deliverText(socket: TcpSocket, payload: unknown, length: number, psh: boolean): void {
    socket.recvNext = (socket.recvNext + length) >>> 0;
    if (!isStreamPayload(payload)) {
      try { socket._fireData(payload); } catch (e) { Logger.warn(this.host.id, 'tcp:onData', String(e)); }
      return;
    }
    socket.recvBuffer = appendStream(socket.recvBuffer, payload);
    const run = socket.reassemblyBuffer.takeFrom(socket.recvNext);
    let pushed = psh;
    if (run.payload !== null) {
      socket.recvBuffer = appendStream(socket.recvBuffer, run.payload);
      socket.recvNext = run.next;
      pushed = pushed || run.psh;
    }
    if (pushed) this.pushToApplication(socket);
  }

  private pushToApplication(socket: TcpSocket): void {
    const pending = socket.recvBuffer;
    if (pending === null) return;
    socket.recvBuffer = null;
    try { socket._fireData(pending); } catch (e) { Logger.warn(this.host.id, 'tcp:onData', String(e)); }
  }

  private processFin(socket: TcpSocket): void {
    socket.reassemblyBuffer.releaseFin();
    this.pushToApplication(socket);
    socket.recvNext = (socket.recvNext + 1) >>> 0;
    this.sendAckNow(socket);
    switch (socket.state) {
      case 'established':
        this._transition(socket, 'close-wait');
        this._initiateClose(socket);
        break;
      case 'fin-wait-1':
        this._transition(socket, 'closing');
        break;
      case 'fin-wait-2':
        this.enterTimeWait(socket);
        break;
      default:
        break;
    }
  }

  private emitOpened(socket: TcpSocket): void {
    this.getBus().publish({
      topic: 'tcp.connection.opened',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        passive: socket.passive,
      },
    });
  }

  _teardown(socket: TcpSocket, reason: TcpCloseReason): void {
    if (socket.closed) return;
    socket.closed = true;
    if (socket.timeWaitTimer) {
      this.timers.clear(socket.timeWaitTimer);
      socket.timeWaitTimer = null;
    }
    this.timers.clear(socket.rtoTimer);
    socket.rtoTimer = null;
    socket.unackedQueue = [];
    this.timers.clear(socket.persistTimer);
    socket.persistTimer = null;
    this.timers.clear(socket.keepAliveTimer);
    socket.keepAliveTimer = null;
    this.forgetOwedAck(socket);
    socket.sndUp = null;
    socket.rcvUp = null;
    socket.sendBacklog = [];
    socket.reassemblyBuffer.clear();
    const unannounced = socket.pendingListener !== null;
    socket.pendingListener = null;
    this._transition(socket, 'closed');
    this.sockets.delete(socket.key());
    if (!unannounced) {
      this.getBus().publish({
        topic: 'tcp.connection.closed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          localIp: socket.localIp, localPort: socket.localPort,
          remoteIp: socket.remoteIp, remotePort: socket.remotePort,
          reason, passive: socket.passive,
        },
      });
    }
    try { socket._fireClose(reason); } catch (e) { Logger.warn(this.host.id, 'tcp:onClose', String(e)); }
  }

  _transition(socket: TcpSocket, newState: TcpState): void {
    if (socket.state === newState) return;
    const oldState = socket.state;
    socket.state = newState;
    if (newState === 'established') socket.everEstablished = true;
    this.getBus().publish({
      topic: 'tcp.state.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        oldState, newState,
      },
    });
  }

  /**
   * PRD-TCP.md P8 — abrupt, application-initiated abort (RFC 9293 §3.10.4):
   * send one real RST at the connection's actual current sequence/ack
   * (unlike `sendRst`'s zeroed-sequence reply to an incoming segment we're
   * rejecting), then tear down locally right away instead of going
   * through FIN-WAIT like `close()` does.
   */
  _abort(socket: TcpSocket): void {
    if (socket.closed) return;
    const flags = noFlags(); flags.rst = true; flags.ack = true;
    this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
    this._teardown(socket, 'rst');
  }

  /** PRD-TCP.md P8 — arm idle-probe keepalive monitoring for this socket. */
  _enableKeepAlive(socket: TcpSocket, idleMs: number, intervalMs: number, maxProbes: number): void {
    socket.keepAliveEnabled = true;
    socket.keepAliveIdleMs = idleMs;
    socket.keepAliveIntervalMs = intervalMs;
    socket.keepAliveMaxProbes = maxProbes;
    socket.keepAliveProbesSent = 0;
    this.rearmKeepAliveTimer(socket);
  }

  /** PRD-TCP.md P8 — disable idle-probe keepalive monitoring for this socket. */
  _disableKeepAlive(socket: TcpSocket): void {
    socket.keepAliveEnabled = false;
    this.timers.clear(socket.keepAliveTimer);
    socket.keepAliveTimer = null;
  }

  /** (Re)start the keepalive idle/probe-interval timer, or leave it disarmed when not applicable. */
  private rearmKeepAliveTimer(socket: TcpSocket): void {
    this.timers.clear(socket.keepAliveTimer);
    socket.keepAliveTimer = null;
    if (!socket.keepAliveEnabled || socket.state !== 'established') return;
    const delay = socket.keepAliveProbesSent === 0 ? socket.keepAliveIdleMs : socket.keepAliveIntervalMs;
    socket.keepAliveTimer = this.timers.setTimeout(() => this.onKeepAliveFired(socket), delay);
  }

  /** RFC 9293 §3.8.4 — no traffic for the idle period: probe, and give up after `keepAliveMaxProbes` unanswered probes. */
  private onKeepAliveFired(socket: TcpSocket): void {
    socket.keepAliveTimer = null;
    if (socket.closed || socket.state !== 'established') return;
    socket.keepAliveProbesSent++;
    if (socket.keepAliveProbesSent > socket.keepAliveMaxProbes) {
      this._teardown(socket, 'timeout');
      return;
    }
    // Probe with a sequence number one behind SND.UNA — already
    // acknowledged, so it doesn't disturb real data or sequence-space
    // bookkeeping, just elicits a duplicate ACK from a still-alive peer.
    const flags = noFlags(); flags.ack = true;
    const probeSeq = (socket.sendUnacked - 1) >>> 0;
    this.transmit(socket, flags, probeSeq, socket.recvNext, undefined);
    this.rearmKeepAliveTimer(socket);
  }

  private sendRst(localIp: string, remoteIp: string, offending: TcpSegment): void {
    const egress = this.resolveEgress(remoteIp);
    if (!egress) return;
    const flags = noFlags();
    flags.rst = true;
    let sequence = 0;
    let acknowledgement = 0;
    if (offending.flags.ack) {
      sequence = offending.acknowledgement;
    } else {
      flags.ack = true;
      acknowledgement = (offending.sequence
        + (offending.flags.syn ? 1 : 0)
        + (offending.flags.fin ? 1 : 0)
        + segmentPayloadSize(offending)) >>> 0;
    }
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: offending.destinationPort, destinationPort: offending.sourcePort,
      sequence, acknowledgement,
      dataOffset: 5, flags, window: 0, checksum: 0, urgentPointer: 0,
      options: [], payload: undefined,
    };
    seg.checksum = computeTcpChecksum(seg, localIp, remoteIp);
    this.shipSegment(egress, localIp, remoteIp, seg);
  }

  /**
   * `extraOptions` carries SYN-specific capability offers (mss/window-scale/
   * sack-permitted) that only make sense on a handshake segment — callers
   * building a SYN/SYN-ACK pass them explicitly (and `UnackedSegment`
   * remembers them so a retransmitted SYN offers the same capabilities,
   * not a bare one). Timestamps (PRD-TCP.md P6, RFC 7323) and outstanding
   * SACK blocks are attached automatically here instead, since they apply
   * uniformly to every segment once negotiated, independent of call site.
   */
  /**
   * Returns the `tsVal` this call actually put on the wire (for the
   * caller's RTTM bookkeeping — PRD-TCP.md P6), or `undefined` if none
   * was sent. That's `socket.timestampsEnabled`'s auto-attached value for
   * any post-negotiation segment, but also covers the one case where
   * `timestampsEnabled` is still false yet a timestamp genuinely goes out
   * anyway: the client's very first SYN, which manually offers a
   * timestamp in `extraOptions` before negotiation has had a chance to
   * complete. Without this fallback, a lost-and-retransmitted initial SYN
   * could never be RTTM-sampled, only Karn-restricted (i.e. never).
   */
  private transmit(
    socket: TcpSocket, flags: TcpFlags, sequence: number, ackNum: number, payload: unknown,
    extraOptions: TcpOption[] = [],
  ): number | undefined {
    const egress = this.resolveEgress(socket.remoteIp);
    if (!egress) { this.dropped(socket.remoteIp, socket.remotePort, 'no-egress'); return undefined; }
    if (flags.ack && ackNum === socket.recvNext) this.forgetOwedAck(socket);
    if (flags.ack) socket.lastAckSent = ackNum;
    if (segmentPayloadSize({ payload } as TcpSegment) > 0) socket.lastDataSentAtMs = this.getScheduler().now();
    const options = [...extraOptions];
    let sentTsVal: number | undefined;
    if (socket.timestampsEnabled) {
      sentTsVal = Math.floor(this.getScheduler().now());
      options.push({ kind: 'timestamp', tsVal: sentTsVal, tsEcr: socket.peerLastTsVal ?? 0 });
    } else {
      const manualTs = extraOptions.find((o): o is Extract<TcpOption, { kind: 'timestamp' }> => o.kind === 'timestamp');
      if (manualTs) sentTsVal = manualTs.tsVal;
    }
    if (socket.sackEnabled && flags.ack && socket.reassemblyBuffer.length > 0) {
      options.push({ kind: 'sack', blocks: socket.reassemblyBuffer.blocks() });
    }
    const stillUrgent = socket.sndUp !== null && seqLt(sequence, socket.sndUp);
    const urgent = stillUrgent ? (socket.sndUp! - sequence) >>> 0 : 0;
    if (stillUrgent) flags.urg = true;
    const window = this.encodeWindowField(socket, flags);
    if (flags.ack && !flags.rst) socket.rcvEdge = (ackNum + this.decodedOwnWindow(socket, flags, window)) >>> 0;
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: socket.localPort, destinationPort: socket.remotePort,
      sequence, acknowledgement: flags.ack ? ackNum : 0,
      dataOffset: optionsDataOffset(options), flags,
      window, checksum: 0,
      urgentPointer: urgent, options, payload,
    };
    const source = sourceAddressOf(socket, egress.srcIp);
    seg.checksum = computeTcpChecksum(seg, source, socket.remoteIp);
    this.shipSegment(egress, source, socket.remoteIp, seg, {
      ttl: socket.ttl?.value, tos: socket.diffServ.value,
    });
    return sentTsVal;
  }

  // RFC 7323 §2.2 — only scale once both sides negotiated it; SYN/SYN-ACK
  // window fields are never scaled.
  private encodeWindowField(socket: TcpSocket, flags: TcpFlags): number {
    if (flags.syn) return Math.min(0xffff, socket.windowSize);
    const offered = this.offeredWindow(socket);
    if (socket.peerWindowScale === null) return Math.min(0xffff, offered);
    return Math.min(0xffff, offered >>> socket.windowScale);
  }

  private decodedOwnWindow(socket: TcpSocket, flags: TcpFlags, field: number): number {
    if (flags.syn || socket.peerWindowScale === null) return field;
    return (field << socket.windowScale) >>> 0;
  }

  private heldWindow(socket: TcpSocket): number {
    if (socket.rcvEdge === null) return socket.windowSize;
    const distance = (socket.rcvEdge - socket.recvNext) >>> 0;
    return distance > 0x7fffffff ? 0 : distance;
  }

  private windowUpdateThreshold(socket: TcpSocket): number {
    return Math.min(Math.floor(socket.windowSize / 2), this.sendMss(socket));
  }

  private offeredWindow(socket: TcpSocket): number {
    const free = Math.max(0, socket.windowSize - socket.unreadBytes);
    if (socket.rcvEdge === null || socket.unreadBytes === 0) return free;
    const proposedEdge = (socket.recvNext + free) >>> 0;
    if (!seqLt(socket.rcvEdge, proposedEdge)) return free;
    const growth = (proposedEdge - socket.rcvEdge) >>> 0;
    return growth >= this.windowUpdateThreshold(socket) ? free : this.heldWindow(socket);
  }

  _receiveSpaceFreed(socket: TcpSocket): void {
    if (socket.closed || socket.rcvEdge === null) return;
    if (socket.state !== 'established' && socket.state !== 'fin-wait-1' && socket.state !== 'fin-wait-2') return;
    if (this.offeredWindow(socket) > this.heldWindow(socket)) this.sendAckNow(socket);
  }

  private decodeWindowField(socket: TcpSocket, seg: TcpSegment): number {
    if (seg.flags.syn || socket.peerWindowScale === null) return seg.window;
    return (seg.window << socket.peerWindowScale) >>> 0;
  }

  /**
   * Like `transmit()`, but for a segment that consumes sequence space
   * (SYN, FIN, or data) — PRD-TCP.md P1. Queues it for retransmission and
   * (re)arms the socket's single RTO timer (RFC 6298: one retransmission
   * timer per connection, not per segment). Pure ACKs/RSTs go through
   * plain `transmit()` and are never retransmitted on their own.
   */
  private transmitTracked(
    socket: TcpSocket, flags: TcpFlags, sequence: number, ackNum: number, payload: unknown, length: number,
    extraOptions: TcpOption[] = [],
  ): void {
    // Queue BEFORE transmitting: Cable delivery is synchronous, so the
    // peer's ACK can re-enter this stack and prune the queue before
    // `transmit()` even returns (same reentrancy this file already works
    // around for `sendNext` above) — pruning an entry that was never
    // pushed would leave it stuck in the queue forever, retransmitting a
    // segment the peer already acknowledged. The entry is a live object
    // reference, so filling in `lastSentTsVal`/`lastSentAtMs` from
    // `transmit()`'s return value after the fact still lands correctly
    // even if a reentrant ACK already looked at (or even pruned) it.
    const now = this.getScheduler().now();
    const entry: UnackedSegment = {
      sequence, length, flags, payload, extraOptions,
      firstSentAtMs: now,
      retransmitCount: 0,
    };
    socket.unackedQueue.push(entry);
    const sentTsVal = this.transmit(socket, flags, sequence, ackNum, payload, extraOptions);
    if (sentTsVal !== undefined) { entry.lastSentTsVal = sentTsVal; entry.lastSentAtMs = now; }
    this.rearmRtoTimer(socket);
  }

  /** Returns the number of genuinely new bytes this ACK covered (0 if it was stale/duplicate). */
  private pruneUnackedQueue(socket: TcpSocket, ackNum: number, ackTsEcr?: number): number {
    // Advance SND.UNA on any forward progress. Several state branches in
    // `_processSegment` already set `sendUnacked` themselves, but only in
    // narrower sub-cases (e.g. established only does it when the incoming
    // segment carries no data) — flow control (P3) needs a value that's
    // always current, since a peer piggybacks ACKs on data constantly.
    const priorUnacked = socket.sendUnacked;
    if (seqLt(socket.sendUnacked, ackNum)) socket.sendUnacked = ackNum;
    let progressed = false;
    while (socket.unackedQueue.length > 0) {
      const head = socket.unackedQueue[0];
      const coveredUpTo = (head.sequence + head.length) >>> 0;
      const fullyAcked = coveredUpTo === ackNum || seqLt(coveredUpTo, ackNum);
      if (!fullyAcked) break;
      // RTTM (PRD-TCP.md P6, RFC 7323 §4.3) bypasses Karn's restriction:
      // if this ACK echoes the timestamp of this segment's most recent
      // (re)transmission, we know unambiguously which attempt it covers.
      // Otherwise fall back to Karn's algorithm (P4, RFC 6298 §2.3): only
      // clock a segment that was never retransmitted at all. Deliberately
      // NOT gated on `socket.timestampsEnabled`: for the handshake-completing
      // SYN-ACK, this prune runs (from `_processSegment`'s generic ack
      // handling) *before* the `syn-sent` case below flips that flag, so
      // gating on it would always miss the one segment (the SYN itself)
      // RTTM most needs to rescue from Karn's restriction.
      if (ackTsEcr !== undefined
        && head.lastSentTsVal === ackTsEcr && head.lastSentAtMs !== undefined) {
        socket.rtt.sample(this.getScheduler().now() - head.lastSentAtMs);
      } else if (head.retransmitCount === 0) {
        socket.rtt.sample(this.getScheduler().now() - head.firstSentAtMs);
      }
      socket.unackedQueue.shift();
      progressed = true;
    }
    if (progressed) socket.rtt.reset();
    this.rearmRtoTimer(socket);
    return progressed ? (ackNum - priorUnacked) >>> 0 : 0;
  }

  /** (Re)start the RTO timer for the current head of the queue, or clear it when nothing is outstanding. */
  private rearmRtoTimer(socket: TcpSocket): void {
    this.timers.clear(socket.rtoTimer);
    socket.rtoTimer = null;
    const head = socket.unackedQueue[0];
    if (!head) return;
    const delay = Math.min(socket.rtt.currentRto(), this.timeUntilGiveUp(socket, head));
    socket.rtoTimer = this.timers.setTimeout(() => this.onRtoFired(socket), delay);
  }

  _userTimeoutChanged(socket: TcpSocket): void {
    if (!socket.closed) this.rearmRtoTimer(socket);
  }

  private giveUpThresholdMs(socket: TcpSocket): number {
    if (socket.userTimeoutMs !== null) return socket.userTimeoutMs;
    return socket.state === 'syn-sent' || socket.state === 'syn-received' ? TCP_SYN_R2_MS : TCP_DATA_R2_MS;
  }

  private retransmissionBaselineMs(socket: TcpSocket, head: UnackedSegment): number {
    const handshaking = socket.state === 'syn-sent' || socket.state === 'syn-received';
    if (socket.peerWindow === 0 && !handshaking) return Math.max(head.firstSentAtMs, socket.lastHeardAtMs);
    return head.firstSentAtMs;
  }

  private timeUntilGiveUp(socket: TcpSocket, head: UnackedSegment): number {
    const threshold = this.giveUpThresholdMs(socket);
    if (!Number.isFinite(threshold)) return Number.POSITIVE_INFINITY;
    const elapsed = this.getScheduler().now() - this.retransmissionBaselineMs(socket, head);
    return Math.max(1, threshold - elapsed);
  }

  private retransmissionGivenUp(socket: TcpSocket, head: UnackedSegment): boolean {
    const threshold = this.giveUpThresholdMs(socket);
    if (!Number.isFinite(threshold)) return false;
    return this.getScheduler().now() - this.retransmissionBaselineMs(socket, head) >= threshold;
  }

  private reportRetransmissionTrouble(socket: TcpSocket, head: UnackedSegment): void {
    if (head.retransmitCount < TCP_R1_RETRANSMITS || socket.troubleReportedFor === head.sequence) return;
    socket.troubleReportedFor = head.sequence;
    this.host.adviseNegative?.(this.resolveEgress(socket.remoteIp)?.nextHopIp ?? socket.remoteIp);
    this.reportError(socket, { source: 'retransmission', attempts: head.retransmitCount, sequence: head.sequence });
  }

  private reportError(socket: TcpSocket, report: TcpErrorReport): void {
    this.getBus().publish({
      topic: 'tcp.error.reported',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        report,
      },
    });
    socket._fireErrorReport(report);
  }

  onIcmpSoftError(
    origSourcePort: number, origDestPort: number, origDestIp: string,
    icmpType: string, icmpCode: number, icmpFrom: string,
  ): void {
    for (const socket of this.sockets.values()) {
      if (socket.localPort !== origSourcePort) continue;
      if (socket.remotePort !== origDestPort) continue;
      if (socket.remoteIp !== origDestIp) continue;
      if (socket.state === 'closed' || socket.state === 'time-wait') continue;
      this.reportError(socket, { source: 'icmp', icmpType, code: icmpCode, from: icmpFrom });
      return;
    }
  }

  /** RFC 6298 §5: retransmit the earliest unacked segment, back off the RTO, and restart the timer. */
  private onRtoFired(socket: TcpSocket): void {
    this.withinBurst(() => this.rtoWithinBurst(socket));
  }

  private rtoWithinBurst(socket: TcpSocket): void {
    socket.rtoTimer = null;
    const head = socket.unackedQueue[0];
    if (!head) return;
    if (this.retransmissionGivenUp(socket, head)) {
      this._teardown(socket, 'timeout');
      return;
    }
    head.retransmitCount++;
    this.reportRetransmissionTrouble(socket, head);
    // RFC 5681 §3.1 — a real timeout means slow start starts over.
    socket.cc.onRtoTimeout((socket.sendNext - socket.sendUnacked) >>> 0);
    socket.sackScoreboard.clear();
    socket.limitedTransmitBytes = 0;
    const rtoMs = socket.rtt.backoff();
    this.getBus().publish({
      topic: 'tcp.retransmit',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        sequence: head.sequence, attempt: head.retransmitCount, rtoMs,
      },
    });
    // Resend with the segment's ORIGINAL flags (and, for a SYN, its
    // original capability offer — `extraOptions`) — a bare SYN must stay a
    // bare SYN (no ack piggybacked) or the peer stops treating it as a
    // connection request; `transmit()` already zeroes `acknowledgement`
    // itself whenever `flags.ack` is false, so `socket.recvNext` here is
    // only actually used for segments that genuinely carry an ACK.
    const now = this.getScheduler().now();
    const sentTsVal = this.transmit(socket, head.flags, head.sequence, socket.recvNext, head.payload, head.extraOptions ?? []);
    if (sentTsVal !== undefined) { head.lastSentTsVal = sentTsVal; head.lastSentAtMs = now; }
    socket.rtoTimer = this.timers.setTimeout(
      () => this.onRtoFired(socket), Math.min(rtoMs, this.timeUntilGiveUp(socket, head)));
  }

  /** RFC 5681 §3.2 — the 3rd duplicate ACK fast-retransmits without waiting for the RTO timer. */
  private fastRetransmit(socket: TcpSocket): void {
    const head = socket.unackedQueue[0];
    if (!head) return;
    head.retransmitCount++;
    this.getBus().publish({
      topic: 'tcp.retransmit',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        sequence: head.sequence, attempt: head.retransmitCount, rtoMs: socket.rtt.currentRto(),
      },
    });
    const now = this.getScheduler().now();
    const sentTsVal = this.transmit(socket, head.flags, head.sequence, socket.recvNext, head.payload, head.extraOptions ?? []);
    if (sentTsVal !== undefined) { head.lastSentTsVal = sentTsVal; head.lastSentAtMs = now; }
  }

  private shipSegment(
    egress: { name: string; port?: import('../hardware/Port').Port; nextHopIp?: string },
    srcIp: string, dstIp: string, seg: TcpSegment, shape?: ScanProbeShape,
  ): void {
    const family = ipFamilyOf(dstIp);
    const local = this.isLocalDestination(dstIp, family);
    const ttl = shape?.ttl ?? this.defaultTtl(family);
    const l3Packet = family === 'ipv6'
      ? this.buildIpv6Segment(srcIp, dstIp, seg, ttl, shape?.tos)
      : this.buildIpv4Segment(srcIp, dstIp, seg, ttl, shape?.fragmentMtu, shape);
    this.getBus().publish({
      topic: 'tcp.segment.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: srcIp, destinationIp: dstIp,
        sourcePort: seg.sourcePort, destinationPort: seg.destinationPort,
        flagsText: flagsString(seg.flags),
        sequence: seg.sequence, acknowledgement: seg.acknowledgement,
        payloadSize: segmentPayloadSize(seg),
        iface: local ? 'lo' : egress.name,
      },
    });
    if (local) {
      const ipv4 = family === 'ipv6' ? undefined : l3Packet as IPv4Packet;
      this.handleSegment(srcIp, dstIp, seg, ipv4 === undefined ? undefined : {
        ttl: ipv4.ttl,
        identification: ipv4.identification,
        tos: ipv4.tos,
        totalLength: ipv4.totalLength,
        dontFragment: (ipv4.flags & 0b010) !== 0,
      });
      return;
    }
    const nextHopIp = egress.nextHopIp ?? dstIp;
    if (family === 'ipv6') {
      this.host.sendIpv6FrameNdpAware?.(
        egress.name, l3Packet as IPv6Packet, new IPv6Address(nextHopIp));
      return;
    }
    const nextHop = new IPAddress(nextHopIp);
    const packet = l3Packet as IPv4Packet;
    if (shape?.fragmentMtu === undefined) {
      this.host.sendIpv4FrameArpAware(egress.name, packet, nextHop);
      return;
    }
    // `fragmentIPv4` compte la MTU du LIEN, en-tete compris ; `fragscan`
    // compte la charge seule.
    const fragments = fragmentIPv4(packet, packet.ihl * 4 + shape.fragmentMtu);
    for (const fragment of fragments) {
      this.host.sendIpv4FrameArpAware(egress.name, fragment, nextHop);
    }
  }

  private defaultTtl(family: IpFamily): number {
    return this.host.defaultTtl?.(family) ?? TCP_DEFAULT_TTL;
  }

  private buildIpv4Segment(
    srcIp: string, dstIp: string, seg: TcpSegment, ttl: number,
    fragmentMtu?: number, shape?: ScanProbeShape,
  ): IPv4Packet {
    const tcpHeaderBytes = seg.dataOffset * 4;
    // PRD-TCP.md P7 (RFC 1191 §1) — DF set, matching real TCP stacks:
    // without it, a smaller-MTU router would just silently fragment
    // instead of reporting back so PMTUD can shrink our MSS.
    return createIPv4Packet(
      new IPAddress(srcIp), new IPAddress(dstIp), IP_PROTO_TCP, ttl,
      seg, tcpHeaderBytes + payloadBytes(seg.payload).length,
      {
        flags: fragmentMtu === undefined && shape?.dontFragment !== false ? IPV4_FLAG_DF : 0,
        ...(shape?.tos === undefined ? {} : { tos: shape.tos }),
        ...(shape?.identification === undefined
          ? {} : { identification: shape.identification }),
      });
  }

  private buildIpv6Segment(
    srcIp: string, dstIp: string, seg: TcpSegment, hopLimit: number, trafficClass = 0,
  ): IPv6Packet {
    const tcpHeaderBytes = seg.dataOffset * 4;
    const payloadLength = tcpHeaderBytes + payloadBytes(seg.payload).length;
    return {
      ...createIPv6Packet(
        new IPv6Address(srcIp), new IPv6Address(dstIp), IP_PROTO_TCP, hopLimit,
        seg, payloadLength,
      ),
      trafficClass,
    };
  }

  private findListener(dstIp: string, port: number): import('./TcpStack').TcpListener | undefined {
    const specific = this.listeners.get(makeListenerKey(dstIp, port));
    if (specific) return specific;
    const wildcard = ipFamilyOf(dstIp) === 'ipv6' ? '::' : '0.0.0.0';
    return this.listeners.get(makeListenerKey(wildcard, port))
      ?? this.listeners.get(makeListenerKey('0.0.0.0', port));
  }

  private nextEphemeral(localIp?: string): number {
    const size = this.ephemeralMax - this.ephemeralMin + 1;
    const inUse = new Set<number>();
    for (const s of this.sockets.values()) {
      if (localIp && s.localIp !== localIp) continue;
      inUse.add(s.localPort);
    }
    for (const l of this.listeners.values()) inUse.add(l.localPort);
    let start = this.nextEphemeralPort;
    if (start < this.ephemeralMin || start > this.ephemeralMax) start = this.ephemeralMin;
    for (let i = 0; i < size; i++) {
      const port = this.ephemeralMin + ((start - this.ephemeralMin + i) % size);
      if (!inUse.has(port)) {
        this.nextEphemeralPort = port + 1;
        if (this.nextEphemeralPort > this.ephemeralMax) this.nextEphemeralPort = this.ephemeralMin;
        return port;
      }
    }
    return -1;
  }

  hasFreeEphemeralPort(localIp?: string): boolean {
    const inUse = new Set<number>();
    for (const s of this.sockets.values()) {
      if (localIp && s.localIp !== localIp) continue;
      if (s.localPort >= this.ephemeralMin && s.localPort <= this.ephemeralMax) inUse.add(s.localPort);
    }
    for (const l of this.listeners.values()) {
      if (l.localPort >= this.ephemeralMin && l.localPort <= this.ephemeralMax) inUse.add(l.localPort);
    }
    const size = this.ephemeralMax - this.ephemeralMin + 1;
    return inUse.size < size;
  }

  private dropped(remoteIp: string, remotePort: number, reason: TcpDropReason): void {
    this.getBus().publish({
      topic: 'tcp.segment.dropped',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: '0.0.0.0', destinationIp: remoteIp,
        sourcePort: 0, destinationPort: remotePort,
        reason,
      },
    });
    void this.startedAtMs;
  }

  private resolveEgress(
    targetIp: string, iface?: string,
  ): { name: string; port?: import('../hardware/Port').Port; srcIp: string; nextHopIp: string } | null {
    if (iface !== undefined) {
      const forced = this.host.getPort(iface);
      const src = forced?.getIPAddress();
      if (!forced || !src) return null;
      const routed = this.host.resolveRoute?.(targetIp);
      return {
        name: forced.getName(), port: forced, srcIp: src.toString(),
        nextHopIp: routed?.iface === iface ? routed.nextHopIp : targetIp,
      };
    }
    if (ipFamilyOf(targetIp) === 'ipv6') return this.resolveEgress6(targetIp);
    // Ce qui arrive ici est censé être une adresse : la résolution de nom
    // est le travail de l'appelant. Mais un nom non résolu y parvenait,
    // et `new IPAddress('localhost')` levait — une exception traversant
    // `connect()` jusqu'à une promesse non rattrapée, donc une trace dans
    // la console de l'utilisateur au lieu d'un refus propre. Une adresse
    // qu'on ne sait pas lire est simplement une destination sans route.
    const parsedTarget = IPAddress.tryParse(targetIp);
    if (!parsedTarget) return null;
    if (!isUnicastDestination(parsedTarget, this.connectedPrefixes())) return null;
    // Avant la recherche de route, et c'est l'ordre du noyau : la table
    // `local` est consultée en premier, si bien qu'un paquet adressé à
    // une adresse que la machine PORTE ne sort jamais sur le fil.
    if (this.isLocalDestination(targetIp, 'ipv4')) {
      return { name: 'lo', srcIp: targetIp, nextHopIp: targetIp };
    }

    if (this.host.resolveRoute) {
      const route = this.host.resolveRoute(targetIp);
      if (route) {
        const port = this.host.getPort(route.iface);
        const src = port?.getIPAddress();
        if (port && src && port.getIsUp()) {
          return { name: port.getName(), port, srcIp: src.toString(), nextHopIp: route.nextHopIp };
        }
      }
    }
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask || !port.getIsUp()) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port, srcIp: ip.toString(), nextHopIp: targetIp };
    }
    return null;
  }

  /**
   * La destination est-elle la machine elle-même ?
   *
   * `127.0.0.1` n'est pas la seule réponse, et c'est le défaut que ceci
   * corrige : sur un vrai Linux la table de routage `local` porte une
   * entrée `local <adresse> dev lo` pour CHAQUE adresse configurée, si
   * bien que `curl http://<ma-propre-adresse>/` atteint le serveur local
   * sans qu'aucune trame ne parte. Ici, seule la boucle locale était
   * traitée : un serveur joignable de toute la topologie ne l'était pas
   * depuis la machine qui l'exécute — `curl 127.0.0.1` répondait et
   * `curl 10.0.0.2` restait sur « Trying… » indéfiniment.
   */
  private connectedPrefixes(): ConnectedIpv4Prefix[] {
    return this.host.getPorts().flatMap((port) => connectedPrefixesOfPort(port));
  }

  private isLocalDestination(targetIp: string, family: IpFamily): boolean {
    if (family === 'ipv6') {
      let v6: IPv6Address;
      try { v6 = new IPv6Address(targetIp); } catch { return false; }
      if (v6.isLoopback()) return true;
      const cible = v6.toString();
      for (const port of this.host.getPorts()) {
        for (const entry of port.getIPv6Addresses?.() ?? []) {
          if (entry.address.toString() === cible) return true;
        }
      }
      return false;
    }
    const v4 = IPAddress.tryParse(targetIp);
    if (!v4) return false;
    if (v4.isLoopback()) return true;
    for (const port of this.host.getPorts()) {
      const own = port.getIPAddress();
      if (own && own.equals(v4)) return true;
    }
    return false;
  }

  private resolveEgress6(
    targetIp: string,
  ): { name: string; port?: import('../hardware/Port').Port; srcIp: string; nextHopIp: string } | null {
    const parsed6 = (() => { try { return new IPv6Address(targetIp); } catch { return null; } })();
    if (parsed6?.isMulticast()) return null;
    if (this.isLocalDestination(targetIp, 'ipv6')) {
      return { name: 'lo', srcIp: targetIp, nextHopIp: targetIp };
    }
    if (!this.host.resolveRoute6 || !this.host.localAddress6) return null;
    const route = this.host.resolveRoute6(targetIp);
    if (!route) return null;
    const port = this.host.getPort(route.iface);
    if (!port || !port.getIsUp()) return null;
    const srcIp = this.host.localAddress6(route.iface, targetIp);
    if (!srcIp) return null;
    return { name: port.getName(), port, srcIp, nextHopIp: route.nextHopIp };
  }
}

function sourceAddressOf(socket: TcpSocket, routed: string): string {
  const pinned = socket.localIp;
  if (pinned === '' || pinned === '0.0.0.0' || pinned === '::') return routed;
  return pinned;
}

import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  type TcpSegment, type TcpFlags, type TcpState, type TcpCloseReason,
  type UnackedSegment, type TcpOption, type TcpWireOutcome,
  noFlags, flagsString, nextIsn, makeSocketKey, makeListenerKey,
  computeTcpChecksum, verifyTcpChecksum, seqLt,
  TCP_DEFAULT_MSS, TCP_DEFAULT_WINDOW, TCP_TIME_WAIT_MS, TCP_MIN_MSS,
} from './types';
import { bogusChecksum, payloadBytes } from '@/network/layers/transport/L4Checksum';
import { fragmentIPv4, IPV4_FLAG_DF } from '@/network/core/Ipv4Fragmentation';
import { PortNumber } from '@/network/core/ports/PortNumber';
import {
  ICMP_UNREACH_NET_PROHIBITED, ICMP_UNREACH_HOST_PROHIBITED,
  ICMP_UNREACH_ADMIN_PROHIBITED,
} from '@/network/core/IcmpErrors';

/**
 * Ce qu'une sonde apatride a vu revenir. `rst-window` distingue un RST a
 * fenetre NON NULLE, seul detail que le balayage par fenetre (`nmap -sW`)
 * regarde : `scan_engine_raw.cc` y lit `(tcp.th_win) ? PORT_OPEN :
 * PORT_CLOSED`.
 */
export type StatelessProbeReply = 'rst' | 'rst-window' | 'syn-ack' | 'none';

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
}

/** La duree de vie qu'une pile TCP pose sur ses propres segments. */
const TCP_DEFAULT_TTL = 64;

interface StatelessProbeWatch {
  seen: 'rst' | 'syn-ack' | 'none';
  window: number;
}

const PROHIBITED_UNREACH_CODES: ReadonlySet<number> = new Set([
  ICMP_UNREACH_NET_PROHIBITED,
  ICMP_UNREACH_HOST_PROHIBITED,
  ICMP_UNREACH_ADMIN_PROHIBITED,
]);
import {
  connectedPrefixesOfPort, isUnicastDestination, type ConnectedIpv4Prefix,
} from '@/network/layers/internet/InternetLayer';
import { RttEstimator, TCP_MAX_RETRANSMITS, TCP_INITIAL_RTO_MS, TCP_MAX_RTO_MS } from './RttEstimator';
import { TcpCongestionControl } from './TcpCongestionControl';
import { encodeOptions, decodeOptions, optionsDataOffset } from './TcpOptionsCodec';
import type { ListenerIdentity, ListenerSocketSink } from './ListenerSocketSink';

/** RFC 7323 §2.2 — our own advertised window-scale shift (always offered on SYN). */
const TCP_WINDOW_SCALE_SHIFT = 7;
/** Bound on out-of-order data buffered for reassembly (PRD-TCP.md P6) — one window's worth. */
const TCP_REASSEMBLY_MAX_BYTES = TCP_DEFAULT_WINDOW;
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

export function segmentPayloadSize(seg: TcpSegment): number {
  if (seg.payload === undefined) return 0;
  return typeof seg.payload === 'string' ? seg.payload.length : 1;
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
  onOpen?: TcpOpenHandler;
  onData?: TcpDataHandler;
  onClose?: TcpCloseHandler;
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
}

export class TcpSocket {
  readonly localIp: string;
  readonly remoteIp: string;
  readonly family: IpFamily;
  localPort: number;
  remotePort: number;
  state: TcpState = 'closed';
  sendNext = 0;
  sendUnacked = 0;
  recvNext = 0;
  windowSize = TCP_DEFAULT_WINDOW;
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
  recvBuffer = '';
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
  /** String chunks queued because the peer's window couldn't take them yet, in send order. `psh` marks the chunk that ends its original write. */
  sendBacklog: Array<{ payload: string; psh: boolean }> = [];
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

  /** RFC 5681 congestion control (PRD-TCP.md P5) — slow start/congestion avoidance/fast recovery. */
  readonly cc: TcpCongestionControl = new TcpCongestionControl(this.mss);

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
  /** Out-of-order segments buffered for reassembly instead of being dropped (PRD-TCP.md P6), bounded by `TCP_REASSEMBLY_MAX_BYTES`. */
  reassemblyBuffer: Array<{ sequence: number; payload: string; psh: boolean }> = [];

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

  constructor(
    private readonly stack: TcpStack,
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
    if (first && this.earlyData.length > 0) {
      const backlog = this.earlyData;
      this.earlyData = [];
      this.earlyDataBytes = 0;
      for (const chunk of backlog) {
        try { handler(chunk); } catch { /* swallow per-handler */ }
      }
    }
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
  private earlyData: unknown[] = [];
  private earlyDataBytes = 0;

  _fireData(data: unknown): void {
    if (this.dataHandlers.length === 0) {
      const len = typeof data === 'string' ? data.length : 1;
      if (this.earlyDataBytes + len > this.windowSize) return;
      this.earlyData.push(data);
      this.earlyDataBytes += len;
      return;
    }
    for (const h of [...this.dataHandlers]) {
      try { h(data); } catch { /* swallow per-handler */ }
    }
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
  ) {}

  key(): string { return makeListenerKey(this.localIp, this.localPort); }
}

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

  listen(localPort: number, opts: TcpListenOptions, localIp = '0.0.0.0'): TcpListener {
    if (!PortNumber.isValid(localPort)) {
      throw new Error(`TCP listener port out of range: ${localPort} (EINVAL)`);
    }
    const listener = new TcpListener(localIp, localPort, opts.onAccept, opts.identity ?? {});
    if (this.listeners.has(listener.key())) {
      throw new Error(`TCP listener already bound on ${localIp}:${localPort} (EADDRINUSE)`);
    }
    this.listeners.set(listener.key(), listener);
    this.socketSink?.announce(localIp, localPort, listener.identity);
    this.getBus().publish({
      topic: 'tcp.listener.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp, localPort, added: true,
      },
    });
    return listener;
  }

  closeListener(localPort: number, localIp = '0.0.0.0'): void {
    const key = makeListenerKey(localIp, localPort);
    if (!this.listeners.delete(key)) return;
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

  connect(rawRemoteIp: string, remotePort: number, opts: TcpConnectOptions = {}): TcpSocket | null {
    if (!this.enabled) return null;
    const remoteIp = canonicalIpText(rawRemoteIp);
    const egress = this.resolveEgress(remoteIp);
    if (!egress) { this.dropped(remoteIp, remotePort, 'no-egress'); return null; }
    const localIp = egress.srcIp;
    const localPort = this.nextEphemeral(localIp);
    if (localPort === -1) {
      this.dropped(remoteIp, remotePort, 'no-ephemeral');
      return null;
    }
    const socket = new TcpSocket(this, localIp, localPort, remoteIp, remotePort);
    if (opts.onOpen) socket.onOpen(opts.onOpen);
    if (opts.onData) socket.onData(opts.onData);
    if (opts.onClose) socket.onClose(opts.onClose);
    socket.passive = false;
    socket.sendNext = nextIsn();
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
  connectOutcome(remoteIp: string, remotePort: number): TcpWireOutcome {
    const socket = this.connect(remoteIp, remotePort);
    if (!socket) return this.hasEgressTo(remoteIp) ? 'timeout' : 'unreachable';
    if (socket.everEstablished) {
      socket.close();
      return 'open';
    }
    if (socket.connectProhibited) return 'prohibited';
    return socket.connectRefused ? 'refused' : 'timeout';
  }

  /**
   * nmap's `Probe TCP NULL q||`, and what `nc host port` prints: open the
   * connection, send nothing, read what the service volunteers, close.
   * `onData` replays the bytes that arrived before the handler existed —
   * the greeting is written while the handshake completes — so the answer
   * comes from the wire and never from the peer's object.
   */
  grabGreeting(remoteIp: string, remotePort: number): string | null {
    const socket = this.connect(remoteIp, remotePort);
    if (!socket) return null;
    if (!socket.everEstablished) { socket.close(); return null; }
    let text = '';
    const stop = socket.onData((chunk) => {
      if (typeof chunk === 'string') text += chunk;
      else if (chunk instanceof Uint8Array) text += new TextDecoder().decode(chunk);
    });
    stop();
    socket.close();
    return text === '' ? null : text;
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
    const target = canonicalIpText(remoteIp);
    const egress = this.resolveEgress(target);
    if (!egress) return 'none';
    const localPort = shape.sourcePort ?? this.nextEphemeral(egress.srcIp);
    if (localPort < 0) return 'none';

    // La trace est posee sur l'adresse REELLEMENT emise : une source
    // forgee ne peut recevoir aucune reponse, et la garder ici serait
    // pretendre en attendre une.
    const srcIp = shape.sourceIp === undefined
      ? egress.srcIp : canonicalIpText(shape.sourceIp);
    const key = makeSocketKey(srcIp, localPort, target, remotePort);
    const watch: StatelessProbeWatch = { seen: 'none', window: 0 };
    this.statelessProbes.set(key, watch);

    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: localPort, destinationPort: remotePort,
      sequence: nextIsn(), acknowledgement: 0,
      dataOffset: 5, flags, window: TCP_DEFAULT_WINDOW,
      checksum: 0, urgentPointer: 0, options: [], payload: undefined,
    };
    const sum = computeTcpChecksum(seg, srcIp, target);
    seg.checksum = shape.badChecksum ? bogusChecksum(sum, IP_PROTO_TCP) : sum;
    try {
      this.shipSegment(egress, srcIp, target, seg, shape);
    } finally {
      this.statelessProbes.delete(key);
    }
    if (watch.seen !== 'rst') return watch.seen;
    return watch.window > 0 ? 'rst-window' : 'rst';
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
    icmpCode?: number,
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
      const dataSegmentOptions: TcpOption[] = socket.timestampsEnabled
        ? [{ kind: 'timestamp', tsVal: 0, tsEcr: 0 }] : [];
      const tcpHeaderBytes = optionsDataOffset(dataSegmentOptions) * 4;
      const ipHeaderBytes = socket.family === 'ipv6' ? 40 : 20;
      const newMss = Math.max(TCP_MIN_MSS, nextHopMtu - ipHeaderBytes - tcpHeaderBytes);
      // Never grow MSS off this signal, but still attempt resegmentation
      // even when it doesn't need to shrink further: an already-queued
      // segment chunked at an *earlier*, larger MSS (before a previous
      // bounce corrected it) can still be individually oversized even
      // though the running `socket.mss` value is already correct.
      if (newMss < socket.mss) socket.mss = newMss;
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
    if (typeof head.payload !== 'string' || head.length <= socket.mss) return;
    socket.unackedQueue.shift();
    socket.sendNext = head.sequence;
    const resegmented: Array<{ payload: string; psh: boolean }> = [];
    let offset = 0;
    while (offset < head.payload.length) {
      const chunk = head.payload.slice(offset, offset + socket.mss);
      offset += chunk.length;
      resegmented.push({ payload: chunk, psh: head.flags.psh && offset >= head.payload.length });
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
    return this.handleSegment(srcIp.toString(), ipPkt.destinationIP.toString(), seg);
  }

  handleIp6(_inPort: string, srcIp: IPv6Address, ipv6: IPv6Packet): boolean {
    if (!this.enabled) return false;
    if (ipv6.nextHeader !== IP_PROTO_TCP) return false;
    const seg = ipv6.payload as TcpSegment | undefined;
    if (!seg || seg.type !== 'tcp') return false;
    return this.handleSegment(srcIp.toString(), ipv6.destinationIP.toString(), seg);
  }

  private handleSegment(senderIp: string, dstIp: string, seg: TcpSegment): boolean {
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
    if (existing) {
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
      socket.recvNext = (seg.sequence + 1) >>> 0;
      socket.sendNext = nextIsn();
      socket.sendUnacked = socket.sendNext;
      // PRD-TCP.md P6 — negotiate against whatever the peer's SYN offered.
      const peerOpts = decodeOptions(seg.options);
      if (peerOpts.mss !== undefined) socket.mss = Math.min(socket.mss, peerOpts.mss);
      socket.peerWindowScale = peerOpts.windowScale ?? null;
      socket.sackEnabled = peerOpts.sackPermitted === true;
      if (peerOpts.timestamp) {
        socket.timestampsEnabled = true;
        socket.peerLastTsVal = peerOpts.timestamp.tsVal;
      }
      this.sockets.set(socket.key(), socket);
      this._transition(socket, 'syn-received');
      if (listener.identity.banner) socket.write(listener.identity.banner);
      try { listener.onAccept(socket); } catch (e) { Logger.warn(this.host.id, 'tcp:accept', String(e)); }
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
        mss: socket.mss,
        windowScale: socket.peerWindowScale !== null ? socket.windowScale : undefined,
        sackPermitted: socket.sackEnabled || undefined,
      });
      this.transmitTracked(socket, flags, synAckSeq, socket.recvNext, undefined, 1, synAckOptions);
      return true;
    }
    const probe = this.statelessProbes.get(socketKey);
    if (probe && seg.flags.syn && seg.flags.ack) probe.seen = 'syn-ack';
    if (seg.flags.rst) {
      if (probe) {
        probe.seen = 'rst';
        probe.window = seg.window;
      }
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
    if (socket.closed) return;
    if (socket.state === 'syn-sent' || socket.state === 'syn-received') {
      socket.pendingSendQueue.push(data);
      return;
    }
    if (socket.state !== 'established' && socket.state !== 'close-wait') return;

    if (typeof data !== 'string') {
      // Object payloads keep the pre-P3 behaviour: a single, non-chunked
      // segment that isn't subject to window-based backlogging — bulk
      // flow control only matters for the string data this stack actually
      // splits by MSS.
      const flags = noFlags(); flags.ack = true; flags.psh = true;
      const seq = socket.sendNext;
      socket.sendNext = (seq + 1) >>> 0;
      this.transmitTracked(socket, flags, seq, socket.recvNext, data, 1);
      return;
    }

    if (data.length === 0) {
      socket.sendBacklog.push({ payload: '', psh: true });
    } else {
      let offset = 0;
      while (offset < data.length) {
        const chunk = data.slice(offset, offset + socket.mss);
        offset += chunk.length;
        socket.sendBacklog.push({ payload: chunk, psh: offset >= data.length });
      }
    }
    this.flushSendBacklog(socket);
  }

  /**
   * Sends as much of `socket.sendBacklog` as the peer's advertised window
   * (PRD-TCP.md P3, RFC 9293 §3.8.6) currently allows, splitting a queued
   * chunk if only part of it fits. Whatever doesn't fit stays queued in
   * order until a future ACK/window-update frees enough room.
   */
  private flushSendBacklog(socket: TcpSocket): void {
    // Reentrant call (see `flushingBacklog`'s doc comment): the outer
    // invocation's `while` loop will pick up the freed window on its very
    // next iteration since the ACK that triggered this reentry already
    // updated `sendUnacked`/`cc.cwnd` before calling back in here — so
    // just return and let that loop keep going in its own stack frame
    // instead of nesting another one.
    if (socket.flushingBacklog) return;
    socket.flushingBacklog = true;
    try {
      while (socket.sendBacklog.length > 0) {
        const inFlight = (socket.sendNext - socket.sendUnacked) >>> 0;
        // PRD-TCP.md P3+P5: bounded by whichever is smaller — the peer's
        // advertised receive window, or our own congestion window.
        const effectiveWindow = Math.min(socket.peerWindow, socket.cc.cwnd);
        const available = effectiveWindow > inFlight ? effectiveWindow - inFlight : 0;
        if (available === 0) break;
        const next = socket.sendBacklog[0];
        const take = Math.min(available, next.payload.length);
        const chunk = next.payload.slice(0, take);
        const remainder = next.payload.slice(take);
        socket.sendBacklog.shift();
        if (remainder.length > 0) {
          socket.sendBacklog.unshift({ payload: remainder, psh: next.psh });
        }
        const flags = noFlags(); flags.ack = true;
        if (next.psh && remainder.length === 0) flags.psh = true;
        const seq = socket.sendNext;
        socket.sendNext = (seq + chunk.length) >>> 0;
        this.transmitTracked(socket, flags, seq, socket.recvNext, chunk, chunk.length);
        if (chunk.length === 0) break; // nothing consumed (zero window) — avoid spinning forever
      }
    } finally {
      socket.flushingBacklog = false;
    }
    this.maybeArmPersistTimer(socket);
  }

  /** (Re)arm or disarm the zero-window persist-probe timer based on current window/backlog state. */
  private maybeArmPersistTimer(socket: TcpSocket): void {
    if (socket.peerWindow > 0 || socket.sendBacklog.length === 0) {
      this.timers.clear(socket.persistTimer);
      socket.persistTimer = null;
      socket.persistBackoffMs = 0;
      return;
    }
    if (socket.persistTimer) return;
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
    socket.persistTimer = null;
    if (socket.closed || socket.sendBacklog.length === 0) { socket.persistBackoffMs = 0; return; }
    const next = socket.sendBacklog[0];
    if (next.payload.length === 0) { this.maybeArmPersistTimer(socket); return; }
    const probe = next.payload.slice(0, 1);
    const remainder = next.payload.slice(1);
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
      // Delegate to _sendData (now that the socket is actually established)
      // rather than duplicating its sequence-advance/chunking logic here:
      // this used to always advance sendNext by exactly 1 regardless of the
      // queued payload's real length, permanently desyncing the sequence
      // space for any socket that had data queued before the handshake
      // completed (e.g. a server writing a greeting banner from `onAccept`,
      // which fires while still in 'syn-received') — every segment after
      // the first queued one would then carry a sequence number the peer's
      // `acceptInOrder` rejects as out-of-order, silently dropping it.
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

  /**
   * RFC 9293 §3.10.7.3-4, refined by RFC 5961 §3.2 — an arriving RST is
   * accepted only where it cannot have been guessed. In SYN-SENT the
   * proof is the ACK field: it must acknowledge the SYN we just sent. In
   * every other state it is the sequence number: exactly RCV.NXT resets
   * the connection, anything else inside the window earns a challenge
   * ACK, and anything outside it is dropped without a word.
   */
  private _processReset(socket: TcpSocket, seg: TcpSegment): void {
    if (socket.state === 'syn-sent') {
      if (!seg.flags.ack || seg.acknowledgement !== socket.sendNext) {
        this.dropped(socket.remoteIp, socket.remotePort, 'bad-state');
        return;
      }
      socket.connectRefused = true;
      this._teardown(socket, 'rst');
      return;
    }

    if (seg.sequence === socket.recvNext) {
      if (socket.state === 'syn-received') socket.connectRefused = true;
      this._teardown(socket, 'rst');
      return;
    }

    const windowEnd = (socket.recvNext + socket.windowSize) >>> 0;
    const inWindow = !seqLt(seg.sequence, socket.recvNext) && seqLt(seg.sequence, windowEnd);
    if (!inWindow) {
      this.dropped(socket.remoteIp, socket.remotePort, 'bad-state');
      return;
    }

    const challenge = noFlags(); challenge.ack = true;
    this.transmit(socket, challenge, socket.sendNext, socket.recvNext, undefined);
  }

  private _processSegment(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    if (seg.flags.rst) {
      this._processReset(socket, seg);
      return;
    }
    // Any ACK (whether or not it also carries data/FIN) can retire queued
    // retransmittable segments (PRD-TCP.md P1) — checked once here rather
    // than in each state branch below, since several of them only update
    // `sendUnacked` in narrower sub-cases than "seg.flags.ack is set".
    // Decode once — timestamps (PRD-TCP.md P6, RFC 7323) apply uniformly
    // to any segment once negotiated, independent of ACK/data content.
    const incomingOpts = decodeOptions(seg.options);
    if (incomingOpts.timestamp
      && (socket.peerLastTsVal === null || seqLt(socket.peerLastTsVal, incomingOpts.timestamp.tsVal))) {
      socket.peerLastTsVal = incomingOpts.timestamp.tsVal;
    }
    if (seg.flags.ack) {
      // A duplicate ACK (RFC 5681 §3.2): no new data acknowledged, this
      // segment itself carries none either, and it's not a handshake/FIN
      // control segment — only meaningful while we actually have
      // something outstanding to protect.
      const isDuplicateAck = payloadSize === 0 && !seg.flags.syn && !seg.flags.fin
        && seg.acknowledgement === socket.sendUnacked && socket.unackedQueue.length > 0;
      if (isDuplicateAck) {
        const flightSize = (socket.sendNext - socket.sendUnacked) >>> 0;
        if (socket.cc.onDuplicateAck(flightSize)) this.fastRetransmit(socket);
      } else {
        const ackedBytes = this.pruneUnackedQueue(socket, seg.acknowledgement, incomingOpts.timestamp?.tsEcr);
        if (ackedBytes > 0) socket.cc.onNewAck(ackedBytes);
      }
    }
    // Every real segment carries a current window value (PRD-TCP.md P3) —
    // a pure window-update segment (no new ACK progress, no data) is how a
    // peer reopens a previously-advertised zero window, so this must run
    // unconditionally, not just alongside the ack-handling above.
    socket.peerWindow = this.decodeWindowField(socket, seg);
    this.flushSendBacklog(socket);
    switch (socket.state) {
      case 'syn-sent':
        if (seg.flags.syn && seg.flags.ack) {
          socket.recvNext = (seg.sequence + 1) >>> 0;
          if (seqLt(socket.sendUnacked, seg.acknowledgement)) socket.sendUnacked = seg.acknowledgement;
          // PRD-TCP.md P6 — finalize negotiation against what the peer's
          // SYN-ACK actually echoed back (`incomingOpts` was already
          // decoded above, alongside the generic peerLastTsVal update).
          if (incomingOpts.mss !== undefined) socket.mss = Math.min(socket.mss, incomingOpts.mss);
          socket.peerWindowScale = incomingOpts.windowScale ?? null;
          socket.sackEnabled = incomingOpts.sackPermitted === true;
          socket.timestampsEnabled = incomingOpts.timestamp !== undefined;
          this._transition(socket, 'established');
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
          this.emitOpened(socket);
          try { socket._fireOpen(); } catch (e) { Logger.warn(this.host.id, 'tcp:onOpen', String(e)); }
          this.flushPendingSends(socket);
        } else if (seg.flags.syn && !seg.flags.ack) {
          socket.recvNext = (seg.sequence + 1) >>> 0;
          const synAckFlags = noFlags(); synAckFlags.syn = true; synAckFlags.ack = true;
          this.transmit(socket, synAckFlags, socket.sendUnacked, socket.recvNext, undefined);
          this._transition(socket, 'syn-received');
        }
        break;
      case 'syn-received':
        if (seg.flags.ack) {
          if (seqLt(socket.sendUnacked, seg.acknowledgement)) socket.sendUnacked = seg.acknowledgement;
          this._transition(socket, 'established');
          this.emitOpened(socket);
          try { socket._fireOpen(); } catch (e) { Logger.warn(this.host.id, 'tcp:onOpen', String(e)); }
          this.flushPendingSends(socket);
          if (payloadSize > 0) this.deliverData(socket, seg);
          if (seg.flags.fin) this.handleIncomingFin(socket);
        }
        break;
      case 'established':
        if (payloadSize > 0) {
          if (!this.acceptInOrder(socket, seg)) break;
          this.deliverData(socket, seg);
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
        } else if (seg.flags.ack && !seg.flags.fin) {
          // Guarded like `pruneUnackedQueue`'s own update (PRD-TCP.md P1):
          // an old/reordered ACK reaching this branch after a newer one
          // already advanced SND.UNA must not walk it backwards — that
          // would inflate `sendNext - sendUnacked` (flow control's
          // in-flight estimate) and can permanently stall the connection
          // if it happens after the last real advance for a transfer.
          if (seqLt(socket.sendUnacked, seg.acknowledgement)) socket.sendUnacked = seg.acknowledgement;
          // RFC 9293 §3.8.4/§3.10.7.4 — a no-payload segment behind our
          // current RCV.NXT carries no new data (this is exactly what a
          // keepalive probe looks like: the peer deliberately resends an
          // already-acknowledged sequence number). Real stacks still ACK
          // an unacceptable/duplicate segment, which is what lets a
          // keepalive probe actually confirm the peer is alive.
          if (seqLt(seg.sequence, socket.recvNext)) {
            const ackFlags = noFlags(); ackFlags.ack = true;
            this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
          }
        }
        if (seg.flags.fin) this.handleIncomingFin(socket);
        break;
      case 'fin-wait-1':
        if (seqLt(socket.sendUnacked, seg.acknowledgement)) socket.sendUnacked = seg.acknowledgement;
        if (seg.flags.fin && seg.flags.ack) {
          socket.recvNext = (seg.sequence + 1) >>> 0;
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
          this.enterTimeWait(socket);
        } else if (seg.flags.fin) {
          socket.recvNext = (seg.sequence + 1) >>> 0;
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
          this._transition(socket, 'closing');
        } else if (seg.flags.ack) {
          this._transition(socket, 'fin-wait-2');
        }
        break;
      case 'fin-wait-2':
        if (seg.flags.fin) {
          socket.recvNext = (seg.sequence + 1) >>> 0;
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
          this.enterTimeWait(socket);
        } else if (payloadSize > 0) {
          if (!this.acceptInOrder(socket, seg)) break;
          this.deliverData(socket, seg);
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
        }
        break;
      case 'close-wait':
        break;
      case 'last-ack':
        if (seg.flags.ack) {
          this._teardown(socket, 'fin');
        }
        break;
      case 'closing':
        if (seg.flags.ack) {
          this.enterTimeWait(socket);
        }
        break;
      case 'time-wait':
        // RFC 9293 §3.10.7 — re-ACK a retransmitted FIN; ignore the rest.
        if (seg.flags.fin) {
          const ackFlags = noFlags(); ackFlags.ack = true;
          this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
        }
        break;
      default:
        break;
    }
    // PRD-TCP.md P8 — any segment from the peer is real activity: reset
    // the idle clock (and the failed-probe count, since the peer just
    // proved it's alive) rather than letting keepalive fire needlessly.
    if (socket.keepAliveEnabled && socket.state === 'established') {
      socket.keepAliveProbesSent = 0;
      this.rearmKeepAliveTimer(socket);
    }
  }

  /**
   * In-order acceptance check (RFC 9293 §3.10.7.4): only a segment
   * starting exactly at RCV.NXT is delivered immediately. A genuinely
   * out-of-order segment (sequence ahead of RCV.NXT) is buffered for
   * reassembly instead of being dropped once SACK is negotiated
   * (PRD-TCP.md P6) — either way, the duplicate ACK answering it now
   * carries real SACK blocks describing what's already buffered, so the
   * sender knows exactly what's still missing.
   */
  private acceptInOrder(socket: TcpSocket, seg: TcpSegment): boolean {
    if (seg.sequence === socket.recvNext) return true;
    // PAWS (RFC 7323 §5) — a segment timestamped older than the highest
    // we've already seen from this peer cannot be useful new data (it
    // predates a legitimate wraparound-safe ordering); drop it silently,
    // matching the rest of "old duplicate" handling.
    if (socket.timestampsEnabled) {
      const opts = decodeOptions(seg.options);
      if (opts.timestamp && socket.peerLastTsVal !== null && seqLt(opts.timestamp.tsVal, socket.peerLastTsVal)) {
        return false;
      }
    }
    if (socket.sackEnabled && typeof seg.payload === 'string' && seqLt(socket.recvNext, seg.sequence)) {
      this.bufferOutOfOrder(socket, seg);
    }
    const ackFlags = noFlags(); ackFlags.ack = true;
    this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
    return false;
  }

  /** Buffer a genuinely out-of-order segment for reassembly (PRD-TCP.md P6), bounded by `TCP_REASSEMBLY_MAX_BYTES`. */
  private bufferOutOfOrder(socket: TcpSocket, seg: TcpSegment): void {
    if (typeof seg.payload !== 'string') return;
    if (socket.reassemblyBuffer.some((e) => e.sequence === seg.sequence)) return; // already buffered
    const bufferedBytes = socket.reassemblyBuffer.reduce((n, e) => n + e.payload.length, 0);
    if (bufferedBytes + seg.payload.length > TCP_REASSEMBLY_MAX_BYTES) return; // over budget — drop, same as before P6
    socket.reassemblyBuffer.push({ sequence: seg.sequence, payload: seg.payload, psh: seg.flags.psh });
  }

  /** Pull any now-contiguous buffered segments into recvBuffer/RCV.NXT (PRD-TCP.md P6). Returns true if any pulled-in segment carried PSH. */
  private drainReassemblyBuffer(socket: TcpSocket): boolean {
    let pshSeen = false;
    while (socket.reassemblyBuffer.length > 0) {
      const idx = socket.reassemblyBuffer.findIndex((e) => e.sequence === socket.recvNext);
      if (idx === -1) break;
      const [entry] = socket.reassemblyBuffer.splice(idx, 1);
      socket.recvBuffer += entry.payload;
      socket.recvNext = (entry.sequence + entry.payload.length) >>> 0;
      if (entry.psh) pshSeen = true;
    }
    return pshSeen;
  }

  /** Hold the pair in TIME-WAIT for 2×MSL before releasing it. */
  private enterTimeWait(socket: TcpSocket): void {
    if (socket.state === 'time-wait') return;
    this._transition(socket, 'time-wait');
    socket.timeWaitTimer = this.timers.setTimeout(() => {
      socket.timeWaitTimer = null;
      this._teardown(socket, 'fin');
    }, TCP_TIME_WAIT_MS);
  }

  private deliverData(socket: TcpSocket, seg: TcpSegment): void {
    const chunkLen = typeof seg.payload === 'string' ? seg.payload.length : 1;
    socket.recvNext = (seg.sequence + chunkLen) >>> 0;
    if (seg.payload === undefined) return;
    if (typeof seg.payload === 'string') {
      socket.recvBuffer += seg.payload;
      // PRD-TCP.md P6 — filling this gap may make previously-buffered
      // out-of-order segments contiguous now; pull them in too before
      // deciding whether to flush to the application.
      const laterPsh = this.drainReassemblyBuffer(socket);
      if (!seg.flags.psh && !laterPsh) return;
      const full = socket.recvBuffer;
      socket.recvBuffer = '';
      try { socket._fireData(full); } catch (e) { Logger.warn(this.host.id, 'tcp:onData', String(e)); }
      return;
    }
    try { socket._fireData(seg.payload); } catch (e) { Logger.warn(this.host.id, 'tcp:onData', String(e)); }
  }

  private handleIncomingFin(socket: TcpSocket): void {
    socket.recvNext = (socket.recvNext + 1) >>> 0;
    const flags = noFlags(); flags.ack = true;
    this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
    this._transition(socket, 'close-wait');
    // Reciprocate the peer's FIN: most simulator-side applications (SSH
    // accept loop, simple echo-style listeners) have no further data to
    // send once the peer half-closes, so the kernel proceeds through
    // LAST-ACK → CLOSED autonomously. Real OpenSSH does the same on
    // SIGPIPE/EOF; without this, the server-side socket would linger in
    // CLOSE-WAIT and appear in `ss -tan` as an orphan after every session.
    this._initiateClose(socket);
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
    socket.sendBacklog = [];
    socket.reassemblyBuffer = [];
    this._transition(socket, 'closed');
    this.sockets.delete(socket.key());
    this.getBus().publish({
      topic: 'tcp.connection.closed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        reason, passive: socket.passive,
      },
    });
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
      options.push({ kind: 'sack', blocks: this.sackBlocksFor(socket) });
    }
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: socket.localPort, destinationPort: socket.remotePort,
      sequence, acknowledgement: flags.ack ? ackNum : 0,
      dataOffset: optionsDataOffset(options), flags,
      window: this.encodeWindowField(socket, flags), checksum: 0, urgentPointer: 0,
      options, payload,
    };
    const source = sourceAddressOf(socket, egress.srcIp);
    seg.checksum = computeTcpChecksum(seg, source, socket.remoteIp);
    this.shipSegment(egress, source, socket.remoteIp, seg);
    return sentTsVal;
  }

  // RFC 7323 §2.2 — only scale once both sides negotiated it; SYN/SYN-ACK
  // window fields are never scaled.
  private encodeWindowField(socket: TcpSocket, flags: TcpFlags): number {
    if (flags.syn || socket.peerWindowScale === null) return socket.windowSize;
    return Math.min(0xffff, socket.windowSize >>> socket.windowScale);
  }

  private decodeWindowField(socket: TcpSocket, seg: TcpSegment): number {
    if (seg.flags.syn || socket.peerWindowScale === null) return seg.window;
    return (seg.window << socket.peerWindowScale) >>> 0;
  }

  /** Merge buffered out-of-order ranges (PRD-TCP.md P6) into RFC 2018 SACK blocks. */
  private sackBlocksFor(socket: TcpSocket): Array<{ start: number; end: number }> {
    const sorted = [...socket.reassemblyBuffer].sort((a, b) => (seqLt(a.sequence, b.sequence) ? -1 : 1));
    const blocks: Array<{ start: number; end: number }> = [];
    for (const entry of sorted) {
      const end = (entry.sequence + entry.payload.length) >>> 0;
      const last = blocks[blocks.length - 1];
      if (last && last.end === entry.sequence) {
        last.end = end;
      } else {
        blocks.push({ start: entry.sequence, end });
      }
    }
    return blocks;
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
    if (socket.unackedQueue.length === 0) return;
    socket.rtoTimer = this.timers.setTimeout(() => this.onRtoFired(socket), socket.rtt.currentRto());
  }

  /** RFC 6298 §5: retransmit the earliest unacked segment, back off the RTO, and restart the timer. */
  private onRtoFired(socket: TcpSocket): void {
    socket.rtoTimer = null;
    const head = socket.unackedQueue[0];
    if (!head) return;
    head.retransmitCount++;
    if (head.retransmitCount > TCP_MAX_RETRANSMITS) {
      this._teardown(socket, 'timeout');
      return;
    }
    // RFC 5681 §3.1 — a real timeout means slow start starts over.
    socket.cc.onRtoTimeout((socket.sendNext - socket.sendUnacked) >>> 0);
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
    socket.rtoTimer = this.timers.setTimeout(() => this.onRtoFired(socket), rtoMs);
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
    const l3Packet = family === 'ipv6'
      ? this.buildIpv6Segment(srcIp, dstIp, seg, shape?.ttl)
      : this.buildIpv4Segment(srcIp, dstIp, seg, shape?.ttl, shape?.fragmentMtu);
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
      this.handleSegment(srcIp, dstIp, seg);
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

  private buildIpv4Segment(
    srcIp: string, dstIp: string, seg: TcpSegment, ttl = TCP_DEFAULT_TTL,
    fragmentMtu?: number,
  ): IPv4Packet {
    const tcpHeaderBytes = seg.dataOffset * 4;
    // PRD-TCP.md P7 (RFC 1191 §1) — DF set, matching real TCP stacks:
    // without it, a smaller-MTU router would just silently fragment
    // instead of reporting back so PMTUD can shrink our MSS.
    return createIPv4Packet(
      new IPAddress(srcIp), new IPAddress(dstIp), IP_PROTO_TCP, ttl,
      seg, tcpHeaderBytes + payloadBytes(seg.payload).length,
      { flags: fragmentMtu === undefined ? IPV4_FLAG_DF : 0 });
  }

  private buildIpv6Segment(
    srcIp: string, dstIp: string, seg: TcpSegment, hopLimit = TCP_DEFAULT_TTL,
  ): IPv6Packet {
    const tcpHeaderBytes = seg.dataOffset * 4;
    const payloadLength = tcpHeaderBytes + payloadBytes(seg.payload).length;
    return createIPv6Packet(
      new IPv6Address(srcIp), new IPv6Address(dstIp), IP_PROTO_TCP, hopLimit,
      seg, payloadLength,
    );
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

  private dropped(remoteIp: string, remotePort: number, reason: 'no-listener' | 'no-socket' | 'bad-state' | 'no-egress' | 'no-source-ip' | 'disabled' | 'bad-checksum' | 'no-ephemeral' | 'listen-ignores-segment'): void {
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
    targetIp: string,
  ): { name: string; port?: import('../hardware/Port').Port; srcIp: string; nextHopIp: string } | null {
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

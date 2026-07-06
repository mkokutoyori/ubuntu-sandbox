import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { TimerSet } from '@/events/TimerSet';
import {
  type TcpSegment, type TcpFlags, type TcpState, type TcpCloseReason,
  type UnackedSegment,
  noFlags, flagsString, nextIsn, makeSocketKey, makeListenerKey,
  computeTcpChecksum, verifyTcpChecksum, seqLt,
  TCP_DEFAULT_MSS, TCP_DEFAULT_WINDOW, TCP_TIME_WAIT_MS,
} from './types';
import { RttEstimator, TCP_MAX_RETRANSMITS, TCP_INITIAL_RTO_MS, TCP_MAX_RTO_MS } from './RttEstimator';
import {
  MACAddress, IPAddress, IPv6Address,
  type EthernetFrame, type IPv4Packet, type IPv6Packet,
  IP_PROTO_TCP, ETHERTYPE_IPV4, ETHERTYPE_IPV6, nextIPv4Id, computeIPv4Checksum,
  createIPv6Packet,
} from '../core/types';
import { Logger } from '../core/Logger';

export type IpFamily = 'ipv4' | 'ipv6';

export function ipFamilyOf(ip: string): IpFamily {
  return ip.includes(':') ? 'ipv6' : 'ipv4';
}

export interface TcpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  resolveMac?(nextHopIp: string): MACAddress | null;
  resolveRoute?(targetIp: string): { iface: string; nextHopIp: string } | null;
  resolveMac6?(nextHopIp: string): MACAddress | null;
  resolveRoute6?(targetIp: string): { iface: string; nextHopIp: string } | null;
  localAddress6?(iface: string, remoteIp: string): string | null;
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

  onOpen(handler: TcpOpenHandler): () => void {
    this.openHandlers.push(handler);
    return () => {
      const i = this.openHandlers.indexOf(handler);
      if (i !== -1) this.openHandlers.splice(i, 1);
    };
  }

  onData(handler: TcpDataHandler): () => void {
    this.dataHandlers.push(handler);
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

  _fireData(data: unknown): void {
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
    this.listeners.clear();
  }

  setEnabled(on: boolean): void { this.enabled = on; }

  listen(localPort: number, opts: TcpListenOptions, localIp = '0.0.0.0'): TcpListener {
    const listener = new TcpListener(localIp, localPort, opts.onAccept);
    if (this.listeners.has(listener.key())) {
      throw new Error(`TCP listener already bound on ${localIp}:${localPort} (EADDRINUSE)`);
    }
    this.listeners.set(listener.key(), listener);
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

  setSocketOwner(socket: TcpSocket, pid: number): void {
    socket.ownerPid = pid;
  }

  connect(remoteIp: string, remotePort: number, opts: TcpConnectOptions = {}): TcpSocket | null {
    if (!this.enabled) return null;
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
    this.transmitTracked(socket, flags, synSeq, 0, undefined, 1);
    return socket;
  }

  /**
   * Synchronous connect probe whose result is derived entirely from the
   * wire: 'open' on an established handshake, 'refused' when the peer
   * answers with a RST or an ICMP unreachable (host firewall REJECT / no
   * listener), 'timeout' when nothing comes back (silent DROP / no route).
   */
  connectOutcome(remoteIp: string, remotePort: number): 'open' | 'refused' | 'timeout' {
    const socket = this.connect(remoteIp, remotePort);
    if (!socket) return 'timeout';
    if (socket.state === 'established') {
      socket.close();
      return 'open';
    }
    return socket.connectRefused ? 'refused' : 'timeout';
  }

  /**
   * An ICMP destination-unreachable carrying one of our outbound TCP
   * segments: fail the matching connection (RFC 1122 §4.2.3.9 — a hard
   * error aborts the connection attempt on a SYN, and is a fatal error
   * on an already-open connection too — e.g. the peer's firewall starts
   * rejecting mid-session).
   */
  onIcmpUnreachable(origSourcePort: number, origDestPort: number, origDestIp: string): void {
    for (const socket of this.sockets.values()) {
      if (socket.localPort !== origSourcePort) continue;
      if (socket.remotePort !== origDestPort) continue;
      if (socket.remoteIp !== origDestIp) continue;
      if (socket.state === 'closed' || socket.state === 'time-wait') continue;
      socket.connectRefused = true;
      this._teardown(socket, 'rst');
      return;
    }
  }

  /**
   * Actively refuse an inbound segment the host firewall rejected: reply
   * with a RST as a real host does for `-j REJECT --reject-with tcp-reset`,
   * so the peer's connect settles as 'refused' rather than timing out.
   */
  sendResetForSegment(localIp: string, senderIp: string, seg: TcpSegment): void {
    if (seg.flags.rst) return;
    this.sendRst(localIp, seg.destinationPort, senderIp, seg.sourcePort, seg.sequence);
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

    const payloadSize = seg.payload === undefined ? 0 : (typeof seg.payload === 'string' ? seg.payload.length : 1);
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
        this.sendRst(dstIp, seg.destinationPort, senderIp, seg.sourcePort, seg.sequence);
        this.dropped(senderIp, seg.sourcePort, 'no-listener');
        return true;
      }
      const socket = new TcpSocket(this, dstIp, seg.destinationPort, senderIp, seg.sourcePort);
      socket.passive = true;
      socket.recvNext = (seg.sequence + 1) >>> 0;
      socket.sendNext = nextIsn();
      socket.sendUnacked = socket.sendNext;
      this.sockets.set(socket.key(), socket);
      this._transition(socket, 'syn-received');
      try { listener.onAccept(socket); } catch (e) { Logger.warn(this.host.id, 'tcp:accept', String(e)); }
      const flags = noFlags(); flags.syn = true; flags.ack = true;
      // Allocate the sequence BEFORE transmitting: Cable delivery is
      // synchronous, so the peer's reply can re-enter this stack and
      // consume sendNext before the post-send increment would run.
      const synAckSeq = socket.sendNext;
      socket.sendNext = (socket.sendNext + 1) >>> 0;
      this.transmitTracked(socket, flags, synAckSeq, socket.recvNext, undefined, 1);
      return true;
    }
    if (seg.flags.rst) {
      return true;
    }
    this.dropped(senderIp, seg.sourcePort, 'no-socket');
    this.sendRst(dstIp, seg.destinationPort, senderIp, seg.sourcePort, seg.sequence);
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
    while (socket.sendBacklog.length > 0) {
      const inFlight = (socket.sendNext - socket.sendUnacked) >>> 0;
      const available = socket.peerWindow > inFlight ? socket.peerWindow - inFlight : 0;
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
    if (socket.pendingSendQueue.length === 0) return;
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
    if (socket.closeAfterFlush) {
      socket.closeAfterFlush = false;
      this._initiateClose(socket);
    }
  }

  _initiateClose(socket: TcpSocket): void {
    if (socket.closed) return;
    if (socket.state === 'syn-sent' || socket.state === 'syn-received') {
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

  private _processSegment(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    if (seg.flags.rst) {
      if (socket.state === 'syn-sent' || socket.state === 'syn-received') {
        socket.connectRefused = true;
      }
      this._teardown(socket, 'rst');
      return;
    }
    // Any ACK (whether or not it also carries data/FIN) can retire queued
    // retransmittable segments (PRD-TCP.md P1) — checked once here rather
    // than in each state branch below, since several of them only update
    // `sendUnacked` in narrower sub-cases than "seg.flags.ack is set".
    if (seg.flags.ack) this.pruneUnackedQueue(socket, seg.acknowledgement);
    // Every real segment carries a current window value (PRD-TCP.md P3) —
    // a pure window-update segment (no new ACK progress, no data) is how a
    // peer reopens a previously-advertised zero window, so this must run
    // unconditionally, not just alongside pruneUnackedQueue above.
    socket.peerWindow = seg.window;
    this.flushSendBacklog(socket);
    switch (socket.state) {
      case 'syn-sent':
        if (seg.flags.syn && seg.flags.ack) {
          socket.recvNext = (seg.sequence + 1) >>> 0;
          socket.sendUnacked = seg.acknowledgement;
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
          socket.sendUnacked = seg.acknowledgement;
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
          socket.sendUnacked = seg.acknowledgement;
        }
        if (seg.flags.fin) this.handleIncomingFin(socket);
        break;
      case 'fin-wait-1':
        socket.sendUnacked = seg.acknowledgement;
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
  }

  /**
   * In-order acceptance check (RFC 9293 §3.10.7.4): only a segment
   * starting exactly at RCV.NXT is delivered. Duplicates and
   * out-of-order segments are answered with a duplicate ACK carrying
   * the expected sequence, and never delivered twice to the app.
   */
  private acceptInOrder(socket: TcpSocket, seg: TcpSegment): boolean {
    if (seg.sequence === socket.recvNext) return true;
    const ackFlags = noFlags(); ackFlags.ack = true;
    this.transmit(socket, ackFlags, socket.sendNext, socket.recvNext, undefined);
    return false;
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
      if (!seg.flags.psh) return;
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
    socket.sendBacklog = [];
    this._transition(socket, 'closed');
    this.sockets.delete(socket.key());
    this.getBus().publish({
      topic: 'tcp.connection.closed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        localIp: socket.localIp, localPort: socket.localPort,
        remoteIp: socket.remoteIp, remotePort: socket.remotePort,
        reason,
      },
    });
    try { socket._fireClose(reason); } catch (e) { Logger.warn(this.host.id, 'tcp:onClose', String(e)); }
  }

  _transition(socket: TcpSocket, newState: TcpState): void {
    if (socket.state === newState) return;
    const oldState = socket.state;
    socket.state = newState;
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

  private sendRst(localIp: string, localPort: number, remoteIp: string, remotePort: number, ackForSeq: number): void {
    const egress = this.resolveEgress(remoteIp);
    if (!egress) return;
    const flags = noFlags(); flags.rst = true; flags.ack = true;
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: localPort, destinationPort: remotePort,
      sequence: 0, acknowledgement: (ackForSeq + 1) >>> 0,
      dataOffset: 5, flags, window: 0, checksum: 0, urgentPointer: 0,
      options: [], payload: undefined,
    };
    seg.checksum = computeTcpChecksum(seg, egress.srcIp, remoteIp);
    this.shipSegment(egress, egress.srcIp, remoteIp, seg);
    void localIp;
  }

  private transmit(socket: TcpSocket, flags: TcpFlags, sequence: number, ackNum: number, payload: unknown): void {
    const egress = this.resolveEgress(socket.remoteIp);
    if (!egress) { this.dropped(socket.remoteIp, socket.remotePort, 'no-egress'); return; }
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: socket.localPort, destinationPort: socket.remotePort,
      sequence, acknowledgement: flags.ack ? ackNum : 0,
      dataOffset: 5, flags,
      window: socket.windowSize, checksum: 0, urgentPointer: 0,
      options: [], payload,
    };
    seg.checksum = computeTcpChecksum(seg, egress.srcIp, socket.remoteIp);
    this.shipSegment(egress, egress.srcIp, socket.remoteIp, seg);
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
  ): void {
    // Queue BEFORE transmitting: Cable delivery is synchronous, so the
    // peer's ACK can re-enter this stack and prune the queue before
    // `transmit()` even returns (same reentrancy this file already works
    // around for `sendNext` above) — pruning an entry that was never
    // pushed would leave it stuck in the queue forever, retransmitting a
    // segment the peer already acknowledged.
    socket.unackedQueue.push({
      sequence, length, flags, payload,
      firstSentAtMs: this.getScheduler().now(),
      retransmitCount: 0,
    });
    this.transmit(socket, flags, sequence, ackNum, payload);
    this.rearmRtoTimer(socket);
  }

  /** Drop every fully-acknowledged segment off the head of the queue and reset the RTO on real progress. */
  private pruneUnackedQueue(socket: TcpSocket, ackNum: number): void {
    // Advance SND.UNA on any forward progress. Several state branches in
    // `_processSegment` already set `sendUnacked` themselves, but only in
    // narrower sub-cases (e.g. established only does it when the incoming
    // segment carries no data) — flow control (P3) needs a value that's
    // always current, since a peer piggybacks ACKs on data constantly.
    if (seqLt(socket.sendUnacked, ackNum)) socket.sendUnacked = ackNum;
    let progressed = false;
    while (socket.unackedQueue.length > 0) {
      const head = socket.unackedQueue[0];
      const coveredUpTo = (head.sequence + head.length) >>> 0;
      const fullyAcked = coveredUpTo === ackNum || seqLt(coveredUpTo, ackNum);
      if (!fullyAcked) break;
      // Karn's algorithm (PRD-TCP.md P4, RFC 6298 §2.3): only clock a
      // segment that was never retransmitted — an ACK covering a
      // retransmission is ambiguous about which attempt it acknowledges.
      if (head.retransmitCount === 0) {
        socket.rtt.sample(this.getScheduler().now() - head.firstSentAtMs);
      }
      socket.unackedQueue.shift();
      progressed = true;
    }
    if (progressed) socket.rtt.reset();
    this.rearmRtoTimer(socket);
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
    // Resend with the segment's ORIGINAL flags — a bare SYN must stay a
    // bare SYN (no ack piggybacked) or the peer stops treating it as a
    // connection request; `transmit()` already zeroes `acknowledgement`
    // itself whenever `flags.ack` is false, so `socket.recvNext` here is
    // only actually used for segments that genuinely carry an ACK.
    this.transmit(socket, head.flags, head.sequence, socket.recvNext, head.payload);
    socket.rtoTimer = this.timers.setTimeout(() => this.onRtoFired(socket), rtoMs);
  }

  private shipSegment(
    egress: { name: string; port: import('../hardware/Port').Port },
    srcIp: string, dstIp: string, seg: TcpSegment,
  ): void {
    const family = ipFamilyOf(dstIp);
    const l3Packet = family === 'ipv6'
      ? this.buildIpv6Segment(srcIp, dstIp, seg)
      : this.buildIpv4Segment(srcIp, dstIp, seg);
    const resolvedMac = family === 'ipv6'
      ? (this.host.resolveMac6?.(dstIp) ?? null)
      : (this.host.resolveMac?.(dstIp) ?? null);
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: resolvedMac ?? MACAddress.broadcast(),
      etherType: family === 'ipv6' ? ETHERTYPE_IPV6 : ETHERTYPE_IPV4,
      payload: l3Packet,
    };
    this.getBus().publish({
      topic: 'tcp.segment.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: srcIp, destinationIp: dstIp,
        sourcePort: seg.sourcePort, destinationPort: seg.destinationPort,
        flagsText: flagsString(seg.flags),
        sequence: seg.sequence, acknowledgement: seg.acknowledgement,
        payloadSize: seg.payload === undefined ? 0 : (typeof seg.payload === 'string' ? seg.payload.length : 1),
      },
    });
    this.host.sendFrame(egress.name, eth);
  }

  private buildIpv4Segment(srcIp: string, dstIp: string, seg: TcpSegment): IPv4Packet {
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + 20 + (seg.payload === undefined ? 0 : 32),
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_TCP, headerChecksum: 0,
      sourceIP: new IPAddress(srcIp), destinationIP: new IPAddress(dstIp),
      payload: seg,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    return ipPkt;
  }

  private buildIpv6Segment(srcIp: string, dstIp: string, seg: TcpSegment): IPv6Packet {
    const payloadLength = 20 + (seg.payload === undefined ? 0 : 32);
    return createIPv6Packet(
      new IPv6Address(srcIp), new IPv6Address(dstIp), IP_PROTO_TCP, 64, seg, payloadLength,
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

  private dropped(remoteIp: string, remotePort: number, reason: 'no-listener' | 'no-socket' | 'bad-state' | 'no-egress' | 'no-source-ip' | 'disabled' | 'bad-checksum' | 'no-ephemeral'): void {
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
  ): { name: string; port: import('../hardware/Port').Port; srcIp: string } | null {
    if (ipFamilyOf(targetIp) === 'ipv6') return this.resolveEgress6(targetIp);

    if (this.host.resolveRoute) {
      const route = this.host.resolveRoute(targetIp);
      if (route) {
        const port = this.host.getPort(route.iface);
        const src = port?.getIPAddress();
        if (port && src && port.getIsUp()) {
          return { name: port.getName(), port, srcIp: src.toString() };
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
      if (same) return { name: port.getName(), port, srcIp: ip.toString() };
    }
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && port.getIsUp() && port.isConnected()) {
        return { name: port.getName(), port, srcIp: ip.toString() };
      }
    }
    return null;
  }

  private resolveEgress6(
    targetIp: string,
  ): { name: string; port: import('../hardware/Port').Port; srcIp: string } | null {
    if (!this.host.resolveRoute6 || !this.host.localAddress6) return null;
    const route = this.host.resolveRoute6(targetIp);
    if (!route) return null;
    const port = this.host.getPort(route.iface);
    if (!port || !port.getIsUp()) return null;
    const srcIp = this.host.localAddress6(route.iface, targetIp);
    if (!srcIp) return null;
    return { name: port.getName(), port, srcIp };
  }
}

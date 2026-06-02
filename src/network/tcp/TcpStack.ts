import type { IEventBus } from '@/events/EventBus';
import {
  type TcpSegment, type TcpFlags, type TcpState, type TcpCloseReason,
  noFlags, flagsString, nextIsn, makeSocketKey, makeListenerKey,
  TCP_DEFAULT_MSS, TCP_DEFAULT_WINDOW,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet,
  IP_PROTO_TCP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface TcpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  resolveMac?(nextHopIp: string): MACAddress | null;
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
  pendingSendQueue: unknown[] = [];
  closeAfterFlush = false;

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
  private startedAtMs = Date.now();

  constructor(
    private readonly host: TcpHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const s of Array.from(this.sockets.values())) {
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

  connect(remoteIp: string, remotePort: number, opts: TcpConnectOptions = {}): TcpSocket | null {
    if (!this.enabled) return null;
    const egress = this.resolveEgress(remoteIp);
    if (!egress) { this.dropped(remoteIp, remotePort, 'no-egress'); return null; }
    const localIpAddr = egress.port.getIPAddress();
    if (!localIpAddr) { this.dropped(remoteIp, remotePort, 'no-source-ip'); return null; }
    const localIp = localIpAddr.toString();
    const localPort = this.nextEphemeral();
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
    this.transmit(socket, flags, socket.sendNext, 0, undefined);
    socket.sendNext = (socket.sendNext + 1) >>> 0;
    return socket;
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
    const senderIp = srcIp.toString();
    const dstIp = ipPkt.destinationIP.toString();

    const payloadSize = seg.payload === undefined ? 0 : 1;
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
      this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
      socket.sendNext = (socket.sendNext + 1) >>> 0;
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
    const flags = noFlags(); flags.ack = true; flags.psh = true;
    this.transmit(socket, flags, socket.sendNext, socket.recvNext, data);
    socket.sendNext = (socket.sendNext + 1) >>> 0;
  }

  private flushPendingSends(socket: TcpSocket): void {
    if (socket.pendingSendQueue.length === 0) return;
    const queued = socket.pendingSendQueue.slice();
    socket.pendingSendQueue.length = 0;
    for (const data of queued) {
      const flags = noFlags(); flags.ack = true; flags.psh = true;
      this.transmit(socket, flags, socket.sendNext, socket.recvNext, data);
      socket.sendNext = (socket.sendNext + 1) >>> 0;
    }
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
      this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
      socket.sendNext = (socket.sendNext + 1) >>> 0;
    } else if (socket.state === 'close-wait') {
      this._transition(socket, 'last-ack');
      const flags = noFlags(); flags.fin = true; flags.ack = true;
      this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
      socket.sendNext = (socket.sendNext + 1) >>> 0;
    } else {
      this._teardown(socket, 'shutdown');
    }
  }

  private _processSegment(socket: TcpSocket, seg: TcpSegment, payloadSize: number): void {
    if (seg.flags.rst) {
      this._teardown(socket, 'rst');
      return;
    }
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
          this._teardown(socket, 'fin');
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
          this._teardown(socket, 'fin');
        } else if (payloadSize > 0) {
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
          this._teardown(socket, 'fin');
        }
        break;
      default:
        break;
    }
  }

  private deliverData(socket: TcpSocket, seg: TcpSegment): void {
    socket.recvNext = (seg.sequence + 1) >>> 0;
    if (seg.payload !== undefined) {
      try { socket._fireData(seg.payload); } catch (e) { Logger.warn(this.host.id, 'tcp:onData', String(e)); }
    }
  }

  private handleIncomingFin(socket: TcpSocket): void {
    socket.recvNext = (socket.recvNext + 1) >>> 0;
    const flags = noFlags(); flags.ack = true;
    this.transmit(socket, flags, socket.sendNext, socket.recvNext, undefined);
    this._transition(socket, 'close-wait');
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
    const srcIpAddr = egress.port.getIPAddress();
    if (!srcIpAddr) return;
    const flags = noFlags(); flags.rst = true; flags.ack = true;
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: localPort, destinationPort: remotePort,
      sequence: 0, acknowledgement: (ackForSeq + 1) >>> 0,
      dataOffset: 5, flags, window: 0, checksum: 0, urgentPointer: 0,
      options: [], payload: undefined,
    };
    this.shipSegment(egress, srcIpAddr, new IPAddress(remoteIp), seg);
    void localIp;
  }

  private transmit(socket: TcpSocket, flags: TcpFlags, sequence: number, ackNum: number, payload: unknown): void {
    const egress = this.resolveEgress(socket.remoteIp);
    if (!egress) { this.dropped(socket.remoteIp, socket.remotePort, 'no-egress'); return; }
    const srcIpAddr = egress.port.getIPAddress();
    if (!srcIpAddr) { this.dropped(socket.remoteIp, socket.remotePort, 'no-source-ip'); return; }
    const seg: TcpSegment = {
      type: 'tcp',
      sourcePort: socket.localPort, destinationPort: socket.remotePort,
      sequence, acknowledgement: flags.ack ? ackNum : 0,
      dataOffset: 5, flags,
      window: socket.windowSize, checksum: 0, urgentPointer: 0,
      options: [], payload,
    };
    this.shipSegment(egress, srcIpAddr, new IPAddress(socket.remoteIp), seg);
  }

  private shipSegment(egress: { name: string; port: import('../hardware/Port').Port },
                      srcIp: IPAddress, dstIp: IPAddress, seg: TcpSegment): void {
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + 20 + (seg.payload === undefined ? 0 : 32),
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_TCP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: dstIp,
      payload: seg,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const resolvedMac = this.host.resolveMac?.(dstIp.toString()) ?? null;
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: resolvedMac ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.getBus().publish({
      topic: 'tcp.segment.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        sourceIp: srcIp.toString(), destinationIp: dstIp.toString(),
        sourcePort: seg.sourcePort, destinationPort: seg.destinationPort,
        flagsText: flagsString(seg.flags),
        sequence: seg.sequence, acknowledgement: seg.acknowledgement,
        payloadSize: seg.payload === undefined ? 0 : 1,
      },
    });
    this.host.sendFrame(egress.name, eth);
  }

  private findListener(dstIp: string, port: number): import('./TcpStack').TcpListener | undefined {
    const specific = this.listeners.get(makeListenerKey(dstIp, port));
    if (specific) return specific;
    return this.listeners.get(makeListenerKey('0.0.0.0', port));
  }

  private nextEphemeral(): number {
    const port = this.nextEphemeralPort;
    this.nextEphemeralPort++;
    if (this.nextEphemeralPort > 65535) this.nextEphemeralPort = 49152;
    return port;
  }

  private dropped(remoteIp: string, remotePort: number, reason: 'no-listener' | 'no-socket' | 'bad-state' | 'no-egress' | 'no-source-ip' | 'disabled'): void {
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

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port };
    }
    for (const port of this.host.getPorts()) {
      if (port.getIPAddress() && port.getIsUp() && port.isConnected()) {
        return { name: port.getName(), port };
      }
    }
    return null;
  }
}

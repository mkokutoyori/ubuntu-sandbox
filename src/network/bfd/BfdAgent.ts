import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type BfdConfig, type BfdSessionRuntime, type BfdPacket, type BfdState, type BfdDiagnostic,
  createDefaultBfdConfig, defaultSession, makeKey,
  detectionTimeMs, negotiatedTxIntervalMs,
  UDP_PORT_BFD_CONTROL,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface BfdHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class BfdAgent {
  private config: BfdConfig = createDefaultBfdConfig();
  private txTimer: TimerHandle | null = null;
  private expiryTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: BfdHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
    if (this.config.enabled) this.startTimers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
    this.stopTimers();
  }

  getConfig(): Readonly<BfdConfig> { return this.config; }

  getSession(iface: string, neighborIp: string): BfdSessionRuntime | undefined {
    return this.config.sessions.get(makeKey(iface, neighborIp));
  }

  listSessions(): BfdSessionRuntime[] {
    return Array.from(this.config.sessions.values())
      .sort((a, b) => a.iface === b.iface ? a.neighborIp.localeCompare(b.neighborIp) : a.iface.localeCompare(b.iface));
  }

  ensureSession(iface: string, neighborIp: string): BfdSessionRuntime {
    const k = makeKey(iface, neighborIp);
    let s = this.config.sessions.get(k);
    if (!s) {
      s = defaultSession(iface, neighborIp);
      this.config.sessions.set(k, s);
      this.kickOnce(s);
    }
    return s;
  }

  removeSession(iface: string, neighborIp: string): void {
    const k = makeKey(iface, neighborIp);
    const s = this.config.sessions.get(k);
    if (s) this.transition(s, 'admin-down', 'admin-down', 'admin');
    this.config.sessions.delete(k);
  }

  setTimers(iface: string, neighborIp: string, txMs: number, rxMs: number, multiplier: number): void {
    const s = this.ensureSession(iface, neighborIp);
    s.desiredMinTxUs = Math.max(50_000, txMs * 1000);
    s.requiredMinRxUs = Math.max(50_000, rxMs * 1000);
    s.detectMultiplier = Math.max(1, Math.min(50, multiplier));
    this.kickOnce(s);
  }

  setAdmin(iface: string, neighborIp: string, up: boolean): void {
    const s = this.ensureSession(iface, neighborIp);
    s.adminUp = up;
    if (!up) this.transition(s, 'admin-down', 'admin-down', 'admin');
    else this.transition(s, 'down', 'none', 'admin');
    this.kickOnce(s);
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.destinationPort !== UDP_PORT_BFD_CONTROL) return;
    const payload = udp.payload as BfdPacket | undefined;
    if (!payload || payload.type !== 'bfd') return;
    const senderIp = srcIp.toString();
    const s = this.config.sessions.get(makeKey(inPort, senderIp));
    if (!s) return;

    this.getBus().publish({
      topic: 'bfd.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: inPort, neighborIp: senderIp,
        remoteState: payload.state,
        myDiscriminator: payload.myDiscriminator,
        yourDiscriminator: payload.yourDiscriminator,
      },
    });

    s.remoteDiscriminator = payload.myDiscriminator;
    s.remoteState = payload.state;
    s.remoteDiag = payload.diagnostic;
    s.remoteMinTxUs = payload.desiredMinTxIntervalUs;
    s.remoteMinRxUs = payload.requiredMinRxIntervalUs;
    s.lastHeardMs = Date.now();

    const next = this.fsmNext(s.state, payload.state, s.adminUp);
    if (next !== s.state) {
      this.transition(s, next, 'none', 'peer');
      this.kickOnce(s);
    }
  }

  private fsmNext(local: BfdState, remote: BfdState, adminUp: boolean): BfdState {
    if (!adminUp) return 'admin-down';
    if (remote === 'admin-down') return 'down';
    if (local === 'admin-down') return 'down';
    if (local === 'down') {
      if (remote === 'down') return 'init';
      if (remote === 'init') return 'up';
      return 'down';
    }
    if (local === 'init') {
      if (remote === 'init' || remote === 'up') return 'up';
      return 'init';
    }
    if (remote === 'down') return 'down';
    return 'up';
  }

  private transition(s: BfdSessionRuntime, newState: BfdState, diag: BfdDiagnostic,
                     reason: 'config' | 'peer' | 'timeout' | 'admin' | 'link'): void {
    if (s.state === newState) return;
    const oldState = s.state;
    s.state = newState;
    s.localDiag = diag;
    s.lastTransitionMs = Date.now();
    this.getBus().publish({
      topic: 'bfd.session.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: s.iface, neighborIp: s.neighborIp,
        oldState, newState, diagnostic: diag, reason,
      },
    });
    Logger.info(this.host.id, 'bfd:state',
      `${this.host.name}: ${s.iface}→${s.neighborIp} ${oldState} → ${newState}`);
  }

  private kickOnce(s: BfdSessionRuntime): void {
    if (!this.shouldEmit(s)) return;
    this.transmit(s);
  }

  private shouldEmit(s: BfdSessionRuntime): boolean {
    if (!this.config.enabled) return false;
    if (!s.adminUp) return false;
    const port = this.host.getPort(s.iface);
    if (!port || !port.getIsUp() || !port.isConnected()) return false;
    const srcIp = port.getIPAddress();
    if (!srcIp) return false;
    return true;
  }

  private transmit(s: BfdSessionRuntime): void {
    const port = this.host.getPort(s.iface);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const payload: BfdPacket = {
      type: 'bfd', version: 1,
      diagnostic: s.localDiag, state: s.state,
      poll: false, final: false,
      controlPlaneIndependent: false, authPresent: false,
      demand: false, multipoint: false,
      detectMultiplier: s.detectMultiplier,
      myDiscriminator: s.localDiscriminator,
      yourDiscriminator: s.remoteDiscriminator,
      desiredMinTxIntervalUs: s.desiredMinTxUs,
      requiredMinRxIntervalUs: s.requiredMinRxUs,
      requiredMinEchoRxIntervalUs: 0,
    };
    const udp: UDPPacket = {
      type: 'udp', sourcePort: 49152 + (s.localDiscriminator & 0x3fff),
      destinationPort: UDP_PORT_BFD_CONTROL,
      length: 8 + 24, checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0xc0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 255, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(s.neighborIp),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(s.iface, eth);
    s.lastTxMs = Date.now();
    this.getBus().publish({
      topic: 'bfd.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        iface: s.iface, neighborIp: s.neighborIp,
        state: s.state,
        myDiscriminator: s.localDiscriminator,
        yourDiscriminator: s.remoteDiscriminator,
      },
    });
  }

  private startTimers(): void {
    const s = this.getScheduler();
    this.scheduler = s;
    if (this.txTimer === null) {
      this.txTimer = s.setInterval(() => {
        const now = Date.now();
        for (const sess of this.config.sessions.values()) {
          if (!this.shouldEmit(sess)) continue;
          const interval = negotiatedTxIntervalMs(sess);
          if (now - sess.lastTxMs >= interval) this.transmit(sess);
        }
      }, 100);
    }
    if (this.expiryTimer === null) {
      this.expiryTimer = s.setInterval(() => this.expireDue(), 100);
    }
  }

  private stopTimers(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.txTimer !== null) { s.clear(this.txTimer); this.txTimer = null; }
    if (this.expiryTimer !== null) { s.clear(this.expiryTimer); this.expiryTimer = null; }
  }

  private expireDue(): void {
    const now = Date.now();
    for (const s of this.config.sessions.values()) {
      if (s.state !== 'up' && s.state !== 'init') continue;
      if (s.lastHeardMs === 0) continue;
      const detect = detectionTimeMs(s);
      if (now - s.lastHeardMs > detect) {
        this.transition(s, 'down', 'control-detection-time-expired', 'timeout');
        s.remoteDiscriminator = 0;
      }
    }
  }

  private installSubscribers(): void {
    const bus = this.getBus();
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.up',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkUp(e.payload.portName),
    ));
    this.unsubscribers.push(bus.subscribeWhere(
      'port.link.down',
      (p) => p.deviceId === this.host.id,
      (e) => this.onLinkDown(e.payload.portName),
    ));
  }

  private onLinkUp(portName: string): void {
    for (const s of this.config.sessions.values()) {
      if (s.iface !== portName) continue;
      this.kickOnce(s);
    }
  }

  private onLinkDown(portName: string): void {
    for (const s of this.config.sessions.values()) {
      if (s.iface !== portName) continue;
      this.transition(s, 'down', 'path-down', 'link');
      s.remoteDiscriminator = 0;
    }
  }
}

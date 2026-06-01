import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type NtpAssociation, type NtpConfig, type NtpPacket,
  createDefaultNtpConfig, defaultAssociation, computeOffsetMs,
  UDP_PORT_NTP,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface NtpHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class NtpAgent {
  private config: NtpConfig = createDefaultNtpConfig();
  private readonly emitting = new Set<string>();
  private pollTimer: TimerHandle | null = null;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: NtpHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.config.enabled) this.startTimer();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.stopTimer();
  }

  getConfig(): Readonly<NtpConfig> { return this.config; }

  setEnabled(on: boolean): void {
    if (this.config.enabled === on) return;
    this.config.enabled = on;
    if (on) this.startTimer();
    else this.stopTimer();
    if (!on) {
      this.getBus().publish({
        topic: 'ntp.unsynced',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), reason: 'admin-disabled' },
      });
      this.config.localStratum = 16;
      this.config.lastSyncMs = 0;
    }
  }

  setServerMode(on: boolean): void {
    this.config.serverMode = on;
    if (on && this.config.localStratum === 16) {
      this.config.localStratum = 8;
      this.config.refIdentifier = 'LOCL';
    }
  }

  addServer(serverIp: string, prefer = false): void {
    if (!this.config.associations.has(serverIp)) {
      this.config.associations.set(serverIp, defaultAssociation(serverIp, prefer));
    } else if (prefer) {
      this.config.associations.get(serverIp)!.prefer = true;
    }
    if (this.config.enabled) this.poll(serverIp);
  }

  removeServer(serverIp: string): void {
    this.config.associations.delete(serverIp);
  }

  setLocalStratum(stratum: number): void {
    if (stratum < 0 || stratum > 16) return;
    this.config.localStratum = stratum;
  }

  getOffsetMs(): number { return this.config.offsetMs; }
  getStratum(): number { return this.config.localStratum; }
  isSynced(): boolean { return this.config.localStratum < 16; }

  now(): number {
    return Date.now() + this.config.offsetMs;
  }

  runningConfigLines(): string[] {
    const out: string[] = [];
    for (const [ip, a] of this.config.associations) {
      out.push(`ntp server ${ip}${a.prefer ? ' prefer' : ''}`);
    }
    if (this.config.serverMode) out.push('ntp master');
    return out;
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.destinationPort !== UDP_PORT_NTP && udp.sourcePort !== UDP_PORT_NTP) return;
    const payload = udp.payload as NtpPacket | undefined;
    if (!payload || payload.type !== 'ntp') return;

    this.getBus().publish({
      topic: 'ntp.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), mode: payload.mode, stratum: payload.stratum,
      },
    });

    if (payload.mode === 'client') {
      if (this.config.serverMode) this.respondAsServer(inPort, srcIp, payload);
      return;
    }
    if (payload.mode === 'server' || payload.mode === 'symmetric-passive') {
      this.acceptServerReply(srcIp.toString(), payload);
    }
  }

  private respondAsServer(inPort: string, clientIp: IPAddress, request: NtpPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const now = this.now();
    const reply: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: 4, mode: 'server',
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0,
      refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs || now,
      origTimestampMs: request.txTimestampMs,
      rxTimestampMs: now, txTimestampMs: now,
    };
    this.sendNtp(inPort, srcIp, clientIp, reply);
    this.getBus().publish({
      topic: 'ntp.server.responded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        clientIp: clientIp.toString(), stratum: this.config.localStratum,
      },
    });
  }

  private acceptServerReply(serverIp: string, reply: NtpPacket): void {
    const a = this.config.associations.get(serverIp);
    if (!a) return;
    const t1 = reply.origTimestampMs;
    const t2 = reply.rxTimestampMs;
    const t3 = reply.txTimestampMs;
    const t4 = Date.now();
    if (t1 === 0) return;
    const { offset, delay } = computeOffsetMs(t1, t2, t3, t4);
    a.lastReplyMs = t4;
    a.reach = (a.reach >>> 1) | 0x80;
    a.stratum = reply.stratum;
    a.offsetMs = offset;
    a.delayMs = delay;
    a.dispersionMs = Math.abs(delay) * 0.5 + 1;
    a.synced = reply.stratum < 16;
    if (a.synced) this.selectAndSync();
  }

  private selectAndSync(): void {
    let best: NtpAssociation | null = null;
    for (const a of this.config.associations.values()) {
      if (!a.synced) continue;
      if (!best) { best = a; continue; }
      if (a.prefer && !best.prefer) { best = a; continue; }
      if (a.prefer === best.prefer) {
        if (a.stratum < best.stratum) { best = a; continue; }
        if (a.stratum === best.stratum && a.dispersionMs < best.dispersionMs) best = a;
      }
    }
    if (!best) return;
    for (const a of this.config.associations.values()) a.preferred = a === best;
    this.config.offsetMs = best.offsetMs;
    this.config.localStratum = best.stratum + 1;
    this.config.refIdentifier = best.serverIp;
    this.config.lastSyncMs = Date.now();
    this.getBus().publish({
      topic: 'ntp.synced',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: best.serverIp, offsetMs: best.offsetMs, delayMs: best.delayMs,
        newStratum: this.config.localStratum,
      },
    });
    Logger.info(this.host.id, 'ntp:synced',
      `${this.host.name}: NTP synced with ${best.serverIp} stratum ${this.config.localStratum} offset ${best.offsetMs}ms`);
  }

  pollAll(): void {
    if (!this.config.enabled) return;
    for (const serverIp of this.config.associations.keys()) this.poll(serverIp);
  }

  private poll(serverIp: string): void {
    const a = this.config.associations.get(serverIp);
    if (!a) return;
    const sourcePort = this.findEgressPort(serverIp);
    if (!sourcePort) return;
    const srcIp = sourcePort.port.getIPAddress();
    if (!srcIp) return;
    const now = Date.now();
    a.lastPollMs = now;
    const request: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: 4, mode: 'client',
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0, refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs,
      origTimestampMs: 0, rxTimestampMs: 0, txTimestampMs: now,
    };
    this.sendNtp(sourcePort.name, srcIp, new IPAddress(serverIp), request);
    this.getBus().publish({
      topic: 'ntp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp, mode: 'client',
      },
    });
  }

  private findEgressPort(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
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

  private sendNtp(portName: string, srcIp: IPAddress, dstIp: IPAddress, payload: NtpPacket): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    const udp: UDPPacket = {
      type: 'udp', sourcePort: UDP_PORT_NTP, destinationPort: UDP_PORT_NTP,
      length: 8 + 48, checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 20 + 8 + 48,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: dstIp, payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const frame: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    const key = `${portName}|${dstIp.toString()}`;
    if (this.emitting.has(key)) return;
    this.emitting.add(key);
    try { this.host.sendFrame(portName, frame); }
    finally { this.emitting.delete(key); }
  }

  private startTimer(): void {
    if (this.pollTimer !== null) return;
    const s = this.getScheduler();
    this.scheduler = s;
    this.pollTimer = s.setInterval(() => this.pollAll(), 64_000);
  }

  private stopTimer(): void {
    const s = this.scheduler ?? this.getScheduler();
    if (this.pollTimer !== null) { s.clear(this.pollTimer); this.pollTimer = null; }
  }
}


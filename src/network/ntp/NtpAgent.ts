import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type NtpAssociation, type NtpConfig, type NtpPacket, type NtpMode,
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

  addServer(serverIp: string, prefer = false, keyId?: number): void {
    if (!this.config.associations.has(serverIp)) {
      const a = defaultAssociation(serverIp, prefer);
      if (keyId !== undefined) a.keyId = keyId;
      this.config.associations.set(serverIp, a);
    } else {
      const a = this.config.associations.get(serverIp)!;
      if (prefer) a.prefer = true;
      if (keyId !== undefined) a.keyId = keyId;
    }
    if (this.config.enabled) {
      try { this.poll(serverIp); } catch { /* invalid target — keep the configuration entry, polling will retry once reachable */ }
    }
  }

  removeServer(serverIp: string): void {
    this.config.associations.delete(serverIp);
  }

  addPeer(peerIp: string, prefer = false, keyId?: number): void {
    if (!this.config.associations.has(peerIp)) {
      const a = defaultAssociation(peerIp, prefer, 'symmetric-active');
      if (keyId !== undefined) a.keyId = keyId;
      this.config.associations.set(peerIp, a);
    } else {
      const a = this.config.associations.get(peerIp)!;
      a.mode = 'symmetric-active';
      if (prefer) a.prefer = true;
      if (keyId !== undefined) a.keyId = keyId;
    }
    if (this.config.enabled) {
      try { this.poll(peerIp); } catch { /* invalid target — keep the configuration entry, polling will retry once reachable */ }
    }
  }

  setSourceInterface(name: string): void { this.config.sourceInterface = name; }
  setAuthenticate(on: boolean): void { this.config.authenticate = on; }
  addAuthKey(id: number, algo: string, key: string): void { this.config.authKeys.set(id, { id, algo, key }); }
  addTrustedKey(id: number): void { this.config.trustedKeys.add(id); }
  setAccessGroup(kind: string, acl: string): void { this.config.accessGroups.set(kind, acl); }

  asRunningConfigLines(): string[] {
    const lines: string[] = [];
    if (this.config.serverMode) {
      lines.push(`ntp master${this.config.localStratum !== 8 ? ' ' + this.config.localStratum : ''}`);
    }
    for (const [ip, a] of this.config.associations) {
      const kind = a.mode === 'symmetric-active' ? 'peer' : 'server';
      lines.push(`ntp ${kind} ${ip}${a.keyId !== undefined ? ' key ' + a.keyId : ''}${a.prefer ? ' prefer' : ''}`);
    }
    if (this.config.sourceInterface) lines.push(`ntp source ${this.config.sourceInterface}`);
    if (this.config.authenticate) lines.push('ntp authenticate');
    for (const k of this.config.authKeys.values()) {
      lines.push(`ntp authentication-key ${k.id} ${k.algo} ${k.key}`);
    }
    for (const id of this.config.trustedKeys) lines.push(`ntp trusted-key ${id}`);
    for (const [kind, acl] of this.config.accessGroups) {
      lines.push(`ntp access-group ${kind} ${acl}`);
    }
    return lines;
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
      const kind = a.mode === 'symmetric-active' ? 'peer' : 'server';
      out.push(`ntp ${kind} ${ip}${a.keyId !== undefined ? ' key ' + a.keyId : ''}${a.prefer ? ' prefer' : ''}`);
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

    if (this.config.authenticate) {
      const auth = this.checkAuthentication(payload);
      if (!auth.ok) {
        this.getBus().publish({
          topic: 'ntp.auth.rejected',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            fromIp: srcIp.toString(), reason: auth.reason,
          },
        });
        return;
      }
    }

    if (payload.mode === 'client') {
      if (this.config.serverMode) this.respondAsServer(inPort, srcIp, payload);
      return;
    }
    if (payload.mode === 'symmetric-active') {
      this.handleSymmetricActive(inPort, srcIp, payload);
      return;
    }
    if (payload.mode === 'server' || payload.mode === 'symmetric-passive') {
      this.acceptServerReply(srcIp.toString(), payload);
    }
  }

  private handleSymmetricActive(inPort: string, peerIp: IPAddress, request: NtpPacket): void {
    const ip = peerIp.toString();
    let a = this.config.associations.get(ip);
    let responseMode: NtpMode;
    if (a && a.mode === 'symmetric-active') {
      responseMode = 'symmetric-active';
    } else {
      if (!a) {
        a = defaultAssociation(ip, false, 'symmetric-passive');
        this.config.associations.set(ip, a);
      }
      responseMode = 'symmetric-passive';
    }
    if (request.origTimestampMs !== 0) this.acceptServerReply(ip, request);
    this.respondSymmetric(inPort, peerIp, request, responseMode);
  }

  private respondSymmetric(inPort: string, peerIp: IPAddress, request: NtpPacket, mode: NtpMode): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const now = this.now();
    const reply: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: 4, mode,
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0,
      refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs || now,
      origTimestampMs: request.txTimestampMs,
      rxTimestampMs: now, txTimestampMs: now,
      keyId: request.keyId,
    };
    this.sendNtp(inPort, srcIp, peerIp, reply);
    this.getBus().publish({
      topic: 'ntp.peer.responded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        peerIp: peerIp.toString(), mode, stratum: this.config.localStratum,
      },
    });
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
      keyId: request.keyId,
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

  private checkAuthentication(payload: NtpPacket): { ok: boolean; reason: 'no-key' | 'untrusted-key' | 'unconfigured' } {
    if (payload.keyId === undefined) return { ok: false, reason: 'no-key' };
    if (!this.config.authKeys.has(payload.keyId)) return { ok: false, reason: 'unconfigured' };
    if (!this.config.trustedKeys.has(payload.keyId)) return { ok: false, reason: 'untrusted-key' };
    return { ok: true, reason: 'no-key' };
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

  private intersect(candidates: NtpAssociation[]): NtpAssociation[] {
    if (candidates.length <= 2) return candidates;
    type Edge = { time: number; lower: boolean };
    const edges: Edge[] = [];
    for (const c of candidates) {
      edges.push({ time: c.offsetMs - c.dispersionMs, lower: true });
      edges.push({ time: c.offsetMs + c.dispersionMs, lower: false });
    }
    edges.sort((x, y) => x.time - y.time || (x.lower === y.lower ? 0 : x.lower ? -1 : 1));
    let count = 0;
    let bestCount = 0;
    let bestLow = -Infinity;
    let bestHigh = Infinity;
    for (const e of edges) {
      if (e.lower) {
        count++;
        if (count > bestCount) { bestCount = count; bestLow = e.time; bestHigh = Infinity; }
      } else {
        if (count === bestCount && e.time < bestHigh) bestHigh = e.time;
        count--;
      }
    }
    const majority = Math.floor(candidates.length / 2) + 1;
    if (bestCount < majority) return candidates;
    return candidates.filter((c) => c.offsetMs >= bestLow && c.offsetMs <= bestHigh);
  }

  private selectAndSync(): void {
    const synced = [...this.config.associations.values()].filter((a) => a.synced);
    const truechimers = this.intersect(synced);
    let best: NtpAssociation | null = null;
    for (const a of truechimers) {
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
    const mode: NtpMode = a.mode === 'symmetric-active' ? 'symmetric-active' : 'client';
    const request: NtpPacket = {
      type: 'ntp', leapIndicator: 0, version: 4, mode,
      stratum: this.config.localStratum, poll: 6, precision: -20,
      rootDelay: 0, rootDispersion: 0, refIdentifier: this.config.refIdentifier,
      refTimestampMs: this.config.lastSyncMs,
      origTimestampMs: 0, rxTimestampMs: 0, txTimestampMs: now,
      keyId: a.keyId,
    };
    this.sendNtp(sourcePort.name, srcIp, new IPAddress(serverIp), request);
    this.getBus().publish({
      topic: 'ntp.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp, mode,
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


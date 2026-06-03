import type { IEventBus } from '@/events/EventBus';
import { getDefaultEventBus } from '@/events/EventBus';
import {
  type SyslogConfig, type SyslogServer, type SyslogPacket,
  type SyslogSeverityName, type SyslogFacilityName,
  createDefaultSyslogConfig, defaultServer,
  severityFromLogLevel, shouldForward, bsdTimestamp,
  SYSLOG_SEVERITY, SYSLOG_FACILITY, UDP_PORT_SYSLOG,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';

export interface SyslogHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class SyslogAgent {
  private config: SyslogConfig = createDefaultSyslogConfig();
  private unsubscribers: Array<() => void> = [];
  private running = false;

  constructor(
    private readonly host: SyslogHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.installSubscribers();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const u of this.unsubscribers) u();
    this.unsubscribers = [];
  }

  getConfig(): Readonly<SyslogConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  setDefaultFacility(facility: SyslogFacilityName): void {
    this.config.defaultFacility = facility;
  }

  setDefaultSeverityThreshold(severity: SyslogSeverityName): void {
    this.config.defaultSeverityThreshold = severity;
    for (const s of this.config.servers.values()) {
      s.severityThreshold = severity;
    }
  }

  setSourceInterface(iface: string | null): void {
    this.config.sourceInterface = iface;
  }

  addServer(ip: string, opts: { facility?: SyslogFacilityName; severityThreshold?: SyslogSeverityName } = {}): void {
    if (this.config.servers.has(ip)) {
      const s = this.config.servers.get(ip)!;
      if (opts.facility) s.facility = opts.facility;
      if (opts.severityThreshold) s.severityThreshold = opts.severityThreshold;
      return;
    }
    const s = defaultServer(ip, opts.facility ?? this.config.defaultFacility,
                                opts.severityThreshold ?? this.config.defaultSeverityThreshold);
    this.config.servers.set(ip, s);
    this.getBus().publish({
      topic: 'syslog.server.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: ip, added: true,
      },
    });
  }

  removeServer(ip: string): void {
    if (!this.config.servers.delete(ip)) return;
    this.getBus().publish({
      topic: 'syslog.server.changed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: ip, added: false,
      },
    });
  }

  listServers(): SyslogServer[] {
    return Array.from(this.config.servers.values()).sort((a, b) => a.ip.localeCompare(b.ip));
  }

  sendImmediate(severity: SyslogSeverityName, tag: string, message: string): void {
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, severity, tag, message);
    }
  }

  private installSubscribers(): void {
    const localBus = this.getBus();
    const defaultBus = getDefaultEventBus();
    const seen = new Set<string>();
    const subscribeOn = (bus: IEventBus): void => {
      this.unsubscribers.push(bus.subscribeWhere(
        'log',
        (p) => p.source === this.host.id,
        (e) => {
          const key = `${e.payload.level}|${e.payload.event}|${e.payload.message}|${Date.now()}`;
          if (seen.has(key)) return;
          seen.add(key);
          if (seen.size > 256) {
            const first = seen.values().next().value;
            if (first !== undefined) seen.delete(first);
          }
          this.onLog(e.payload.level, e.payload.event, e.payload.message);
        },
      ));
    };
    subscribeOn(localBus);
    if (localBus !== defaultBus) subscribeOn(defaultBus);
    const subscribeEntryOn = (bus: IEventBus): void => {
      this.unsubscribers.push(bus.subscribeWhere(
        'device.syslog.entry',
        (p) => p.deviceId === this.host.id,
        (e) => this.onLoggingEntry(e.payload),
      ));
    };
    subscribeEntryOn(localBus);
    if (localBus !== defaultBus) subscribeEntryOn(defaultBus);
  }

  private onLoggingEntry(p: {
    deviceId: string; severity: SyslogSeverityName; tag: string; message: string;
  }): void {
    if (!this.config.enabled) return;
    if (this.config.servers.size === 0) return;
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, p.severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, p.severity, p.tag.toUpperCase(), p.message);
    }
  }

  private onLog(level: 'debug' | 'info' | 'warn' | 'error', event: string, message: string): void {
    if (!this.config.enabled) return;
    if (this.config.servers.size === 0) return;
    const severity = severityFromLogLevel(level);
    const tag = this.tagFor(event);
    for (const s of this.config.servers.values()) {
      if (!shouldForward(s.severityThreshold, severity)) {
        this.dropped(s.ip, 'threshold');
        continue;
      }
      this.deliver(s, severity, tag, message);
    }
  }

  private tagFor(event: string): string {
    const m = /^([a-z][a-z0-9-]*?):([a-z][a-z0-9-]*)/i.exec(event);
    if (m) return `%${m[1].toUpperCase()}-6-${m[2].toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    return `%${event.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  }

  private deliver(s: SyslogServer, severity: SyslogSeverityName, tag: string, message: string): void {
    const egress = this.resolveEgress(s.ip);
    if (!egress) { this.dropped(s.ip, 'no-route'); return; }
    if (!egress.port.getIsUp() || !egress.port.isConnected()) {
      this.dropped(s.ip, 'link-down'); return;
    }
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) { this.dropped(s.ip, 'no-source-ip'); return; }
    const facilityNum = SYSLOG_FACILITY[s.facility];
    const severityNum = SYSLOG_SEVERITY[severity];
    const payload: SyslogPacket = {
      type: 'syslog',
      facility: facilityNum, severity: severityNum,
      hostname: this.host.getHostname(),
      tag, message,
      timestamp: bsdTimestamp(Date.now()),
    };
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 49152 + ((s.count + 1) & 0x3fff),
      destinationPort: UDP_PORT_SYSLOG,
      length: 8 + payload.message.length + payload.tag.length + 32,
      checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(s.ip),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4,
      payload: ipPkt,
    };
    this.host.sendFrame(egress.name, eth);
    s.count++;
    s.lastSentMs = Date.now();
    this.getBus().publish({
      topic: 'syslog.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: s.ip, facility: s.facility, severity, tag, message,
      },
    });
  }

  private dropped(serverIp: string, reason: 'no-route' | 'no-source-ip' | 'threshold' | 'disabled' | 'link-down'): void {
    this.getBus().publish({
      topic: 'syslog.packet.dropped',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp, reason,
      },
    });
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    if (this.config.sourceInterface) {
      const p = this.host.getPort(this.config.sourceInterface);
      if (p) return { name: this.config.sourceInterface, port: p };
    }
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

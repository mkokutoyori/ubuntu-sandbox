import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type RadiusClientConfig, type RadiusServerConfig, type RadiusPacket,
  type RadiusAttribute,
  createDefaultClientConfig, defaultServerEntry, attr, getAttr, makeAuthenticator,
  encryptUserPassword,
  UDP_PORT_RADIUS_AUTH,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface RadiusClientHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

interface PendingRequest {
  identifier: number;
  serverIp: string;
  username: string;
  resolve: (accepted: boolean) => void;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

export class RadiusClientAgent {
  private config: RadiusClientConfig = createDefaultClientConfig();
  private pending = new Map<number, PendingRequest>();
  private nextIdentifier = 1;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: RadiusClientHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const p of this.pending.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
      p.resolve(false);
    }
    this.pending.clear();
  }

  getConfig(): Readonly<RadiusClientConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  addServer(ip: string, sharedSecret: string, opts: { port?: number; timeoutMs?: number; retransmit?: number } = {}): void {
    const existing = this.config.servers.find((s) => s.ip === ip);
    if (existing) {
      existing.sharedSecret = sharedSecret;
      if (opts.port) existing.authPort = opts.port;
      if (opts.timeoutMs) existing.timeoutMs = opts.timeoutMs;
      if (opts.retransmit !== undefined) existing.retransmit = opts.retransmit;
      return;
    }
    const s = defaultServerEntry(ip, sharedSecret);
    if (opts.port) s.authPort = opts.port;
    if (opts.timeoutMs) s.timeoutMs = opts.timeoutMs;
    if (opts.retransmit !== undefined) s.retransmit = opts.retransmit;
    this.config.servers.push(s);
  }

  removeServer(ip: string): void {
    this.config.servers = this.config.servers.filter((s) => s.ip !== ip);
  }

  setNasIdentifier(id: string | null): void { this.config.nasIdentifier = id; }
  setSourceInterface(iface: string | null): void { this.config.sourceInterface = iface; }

  listServers(): RadiusServerConfig[] { return this.config.servers.slice(); }

  authenticate(username: string, password: string, serverIp?: string): Promise<boolean> {
    if (!this.config.enabled) return Promise.resolve(false);
    const server = serverIp
      ? this.config.servers.find((s) => s.ip === serverIp)
      : this.config.servers[0];
    if (!server) return Promise.resolve(false);
    const identifier = this.nextIdentifier;
    this.nextIdentifier = (this.nextIdentifier + 1) & 0xff;
    return new Promise<boolean>((resolve) => {
      const pending: PendingRequest = {
        identifier, serverIp: server.ip, username,
        resolve, timer: null,
        attemptsLeft: server.retransmit,
      };
      this.pending.set(identifier, pending);
      this.transmit(server, identifier, username, password);
      this.armTimeout(server, pending, username, password);
    });
  }

  handleUdp(_inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.sourcePort !== UDP_PORT_RADIUS_AUTH && udp.destinationPort !== UDP_PORT_RADIUS_AUTH) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;
    if (payload.code !== 'access-accept' && payload.code !== 'access-reject') return;
    const pending = this.pending.get(payload.identifier);
    if (!pending) return;
    if (pending.serverIp !== srcIp.toString()) return;

    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), code: payload.code, identifier: payload.identifier,
      },
    });

    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pending.delete(payload.identifier);
    const accepted = payload.code === 'access-accept';
    const reasonAttr = getAttr(payload, 'reply-message');
    const reason = reasonAttr ? String(reasonAttr.value) : null;
    pending.resolve(accepted);
    this.getBus().publish({
      topic: 'radius.auth.completed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: srcIp.toString(), username: pending.username,
        accepted, identifier: payload.identifier, reason,
      },
    });
    Logger.info(this.host.id, 'radius:auth',
      `${this.host.name}: ${pending.username}@${srcIp} → ${accepted ? 'Access-Accept' : 'Access-Reject'}`);
  }

  private armTimeout(server: RadiusServerConfig, pending: PendingRequest, username: string, password: string): void {
    const s = this.getScheduler();
    this.scheduler = s;
    pending.timer = s.setTimeout(() => {
      if (!this.pending.has(pending.identifier)) return;
      if (pending.attemptsLeft > 0) {
        pending.attemptsLeft--;
        this.transmit(server, pending.identifier, username, password);
        this.armTimeout(server, pending, username, password);
      } else {
        this.pending.delete(pending.identifier);
        pending.resolve(false);
        this.getBus().publish({
          topic: 'radius.auth.completed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            serverIp: server.ip, username,
            accepted: false, identifier: pending.identifier, reason: 'timeout',
          },
        });
      }
    }, server.timeoutMs);
  }

  private transmit(server: RadiusServerConfig, identifier: number, username: string, password: string): void {
    const egress = this.resolveEgress(server.ip);
    if (!egress) return;
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) return;
    const authenticator = makeAuthenticator(identifier ^ Date.now());
    const encryptedPassword = encryptUserPassword(password, server.sharedSecret, authenticator);
    const attrs: RadiusAttribute[] = [
      attr('user-name', username),
      attr('user-password', encryptedPassword),
      attr('nas-ip-address', srcIp.toString()),
    ];
    if (this.config.nasIdentifier) attrs.push(attr('nas-identifier', this.config.nasIdentifier));
    const payload: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier,
      authenticator,
      attributes: attrs,
    };
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 49152 + (identifier & 0x3fff),
      destinationPort: server.authPort,
      length: 20 + 32 + username.length + password.length,
      checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: new IPAddress(server.ip),
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(egress.name, eth);
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: server.ip, code: 'access-request', identifier, username,
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

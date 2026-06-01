import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type TacacsClientConfig, type TacacsServerConfig, type TacacsPacket,
  type TacacsAuthenStatus, type TacacsAuthorStatus, type TacacsAcctStatus, type TacacsAcctFlag,
  type TacacsHeader, type TacacsBody,
  createDefaultClientConfig, defaultServerEntry,
  PORT_TACACS,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface TacacsClientHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

interface PendingSession {
  sessionId: number;
  serverIp: string;
  username: string;
  resolveAuthen?: (status: TacacsAuthenStatus | 'timeout', privLvl: number | null) => void;
  resolveAuthor?: (status: TacacsAuthorStatus | 'timeout') => void;
  resolveAcct?: (status: TacacsAcctStatus | 'timeout') => void;
  timer: TimerHandle | null;
  flags?: TacacsAcctFlag[];
  command?: string;
}

export class TacacsClientAgent {
  private config: TacacsClientConfig = createDefaultClientConfig();
  private pending = new Map<number, PendingSession>();
  private nextSessionId = 1;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: TacacsClientHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const p of this.pending.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
      if (p.resolveAuthen) p.resolveAuthen('timeout', null);
      if (p.resolveAuthor) p.resolveAuthor('timeout');
      if (p.resolveAcct) p.resolveAcct('timeout');
    }
    this.pending.clear();
  }

  getConfig(): Readonly<TacacsClientConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  addServer(ip: string, sharedSecret: string, opts: { port?: number; timeoutMs?: number } = {}): void {
    const existing = this.config.servers.find((s) => s.ip === ip);
    if (existing) {
      existing.sharedSecret = sharedSecret;
      if (opts.port) existing.port = opts.port;
      if (opts.timeoutMs) existing.timeoutMs = opts.timeoutMs;
      return;
    }
    const s = defaultServerEntry(ip, sharedSecret);
    if (opts.port) s.port = opts.port;
    if (opts.timeoutMs) s.timeoutMs = opts.timeoutMs;
    this.config.servers.push(s);
  }

  removeServer(ip: string): void {
    this.config.servers = this.config.servers.filter((s) => s.ip !== ip);
  }

  setNasIdentifier(id: string | null): void { this.config.nasIdentifier = id; }
  setSourceInterface(iface: string | null): void { this.config.sourceInterface = iface; }
  listServers(): TacacsServerConfig[] { return this.config.servers.slice(); }

  authenticate(username: string, password: string, serverIp?: string): Promise<{ status: TacacsAuthenStatus | 'timeout'; privLvl: number | null }> {
    const server = this.selectServer(serverIp);
    if (!server) return Promise.resolve({ status: 'timeout', privLvl: null });
    const sessionId = this.nextSession();
    return new Promise((resolve) => {
      const pending: PendingSession = {
        sessionId, serverIp: server.ip, username, timer: null,
        resolveAuthen: (status, privLvl) => resolve({ status, privLvl }),
      };
      this.pending.set(sessionId, pending);
      const body: TacacsBody = {
        type: 'tacacs-authen-start',
        action: 'login', privLvl: 1, authenType: 'ascii', service: 'login',
        user: username, port: 'tty0', remoteAddress: '0.0.0.0',
        data: password,
      };
      this.transmit(server, sessionId, 'authen', body);
      this.armTimeout(server, pending);
    });
  }

  authorize(username: string, command: string, serverIp?: string): Promise<TacacsAuthorStatus | 'timeout'> {
    const server = this.selectServer(serverIp);
    if (!server) return Promise.resolve('timeout');
    const sessionId = this.nextSession();
    return new Promise((resolve) => {
      const pending: PendingSession = {
        sessionId, serverIp: server.ip, username, timer: null,
        resolveAuthor: (status) => resolve(status),
        command,
      };
      this.pending.set(sessionId, pending);
      const body: TacacsBody = {
        type: 'tacacs-author-request',
        authenMethod: 6, privLvl: 1, authenType: 'ascii', service: 'login',
        user: username, port: 'tty0', remoteAddress: '0.0.0.0',
        args: [`service=shell`, `cmd=${command}`],
      };
      this.transmit(server, sessionId, 'author', body);
      this.armTimeout(server, pending);
    });
  }

  accountCommand(username: string, command: string, flags: TacacsAcctFlag[], serverIp?: string): Promise<TacacsAcctStatus | 'timeout'> {
    const server = this.selectServer(serverIp);
    if (!server) return Promise.resolve('timeout');
    const sessionId = this.nextSession();
    return new Promise((resolve) => {
      const pending: PendingSession = {
        sessionId, serverIp: server.ip, username, timer: null,
        resolveAcct: (status) => resolve(status), flags, command,
      };
      this.pending.set(sessionId, pending);
      const body: TacacsBody = {
        type: 'tacacs-acct-request',
        flags, authenMethod: 6, privLvl: 1, authenType: 'ascii', service: 'login',
        user: username, port: 'tty0', remoteAddress: '0.0.0.0',
        args: [`service=shell`, `cmd=${command}`],
      };
      this.transmit(server, sessionId, 'acct', body);
      this.armTimeout(server, pending);
    });
  }

  handleUdp(_inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.sourcePort !== PORT_TACACS && udp.destinationPort !== PORT_TACACS) return;
    const payload = udp.payload as TacacsPacket | undefined;
    if (!payload || payload.type !== 'tacacs') return;
    const sessionId = payload.header.sessionId;
    const pending = this.pending.get(sessionId);
    if (!pending || pending.serverIp !== srcIp.toString()) return;
    this.getBus().publish({
      topic: 'tacacs.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), sessionId, bodyType: payload.body.type,
      },
    });
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pending.delete(sessionId);

    if (payload.body.type === 'tacacs-authen-reply' && pending.resolveAuthen) {
      pending.resolveAuthen(payload.body.status, payload.body.status === 'pass' ? 15 : null);
      this.getBus().publish({
        topic: 'tacacs.authen.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp: srcIp.toString(), username: pending.username,
          status: payload.body.status, privLvl: payload.body.status === 'pass' ? 15 : null,
        },
      });
      Logger.info(this.host.id, 'tacacs:authen',
        `${this.host.name}: ${pending.username}@${srcIp} → ${payload.body.status}`);
      return;
    }
    if (payload.body.type === 'tacacs-author-reply' && pending.resolveAuthor) {
      pending.resolveAuthor(payload.body.status);
      this.getBus().publish({
        topic: 'tacacs.author.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp: srcIp.toString(), username: pending.username,
          status: payload.body.status, command: pending.command ?? null,
        },
      });
      return;
    }
    if (payload.body.type === 'tacacs-acct-reply' && pending.resolveAcct) {
      pending.resolveAcct(payload.body.status);
      this.getBus().publish({
        topic: 'tacacs.acct.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp: srcIp.toString(), username: pending.username,
          flags: pending.flags ?? [], status: payload.body.status,
        },
      });
      return;
    }
  }

  private selectServer(serverIp?: string): TacacsServerConfig | undefined {
    if (!this.config.enabled) return undefined;
    return serverIp
      ? this.config.servers.find((s) => s.ip === serverIp)
      : this.config.servers[0];
  }

  private nextSession(): number {
    const id = this.nextSessionId;
    this.nextSessionId = (this.nextSessionId + 1) & 0x7fffffff;
    return id;
  }

  private armTimeout(server: TacacsServerConfig, pending: PendingSession): void {
    const s = this.getScheduler();
    this.scheduler = s;
    pending.timer = s.setTimeout(() => {
      if (!this.pending.has(pending.sessionId)) return;
      this.pending.delete(pending.sessionId);
      if (pending.resolveAuthen) pending.resolveAuthen('timeout', null);
      if (pending.resolveAuthor) pending.resolveAuthor('timeout');
      if (pending.resolveAcct) pending.resolveAcct('timeout');
    }, server.timeoutMs);
  }

  private transmit(server: TacacsServerConfig, sessionId: number, kind: 'authen' | 'author' | 'acct', body: TacacsBody): void {
    const egress = this.resolveEgress(server.ip);
    if (!egress) return;
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) return;
    const header: TacacsHeader = {
      version: 0xc1,
      type: kind === 'authen' ? 1 : kind === 'author' ? 2 : 3,
      seqNo: 1, flags: 0, sessionId, length: 64,
    };
    const payload: TacacsPacket = { type: 'tacacs', header, body };
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 49152 + (sessionId & 0x3fff),
      destinationPort: server.port,
      length: 8 + 64, checksum: 0, payload,
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
      srcMAC: egress.port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(egress.name, eth);
    this.getBus().publish({
      topic: 'tacacs.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: server.ip, sessionId, bodyType: body.type,
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

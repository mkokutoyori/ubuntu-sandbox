import type { IEventBus } from '@/events/EventBus';
import {
  type TacacsServerAgentConfig, type TacacsPacket, type TacacsUser,
  type TacacsAuthenStatus, type TacacsAuthorStatus, type TacacsAcctStatus,
  type TacacsBody, type TacacsHeader,
  createDefaultServerConfig, defaultUser,
  PORT_TACACS,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import { Logger } from '../core/Logger';

export interface TacacsServerHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
}

export class TacacsServerAgent {
  private config: TacacsServerAgentConfig = createDefaultServerConfig();
  private running = false;

  constructor(
    private readonly host: TacacsServerHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  getConfig(): Readonly<TacacsServerAgentConfig> { return this.config; }
  setEnabled(on: boolean): void { this.config.enabled = on; }
  setSharedSecret(secret: string): void { this.config.sharedSecret = secret; }

  addUser(username: string, password: string, privLvl = 1, permittedCommands: string[] = []): void {
    const u = defaultUser(username, password, privLvl);
    for (const c of permittedCommands) u.permittedCommands.add(c);
    this.config.users.set(username, u);
  }

  removeUser(username: string): void { this.config.users.delete(username); }

  listUsers(): TacacsUser[] { return Array.from(this.config.users.values()); }

  getAccountingLog(): ReadonlyArray<{ user: string; cmd: string; flags: string[]; ts: number }> {
    return this.config.acctLog.map((r) => ({ ...r, flags: r.flags.slice() }));
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running || !this.config.enabled) return;
    if (udp.destinationPort !== this.config.port) return;
    const payload = udp.payload as TacacsPacket | undefined;
    if (!payload || payload.type !== 'tacacs') return;

    this.getBus().publish({
      topic: 'tacacs.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), sessionId: payload.header.sessionId,
        bodyType: payload.body.type,
      },
    });

    if (payload.body.type === 'tacacs-authen-start') {
      this.replyAuthen(inPort, srcIp, payload, payload.body.user, payload.body.data);
      return;
    }
    if (payload.body.type === 'tacacs-author-request') {
      const cmd = this.extractCmd(payload.body.args);
      this.replyAuthor(inPort, srcIp, payload, payload.body.user, cmd);
      return;
    }
    if (payload.body.type === 'tacacs-acct-request') {
      const cmd = this.extractCmd(payload.body.args);
      this.config.acctLog.push({
        user: payload.body.user, cmd: cmd ?? '',
        flags: payload.body.flags.slice(), ts: Date.now(),
      });
      this.replyAcct(inPort, srcIp, payload);
      return;
    }
  }

  private extractCmd(args: string[]): string | null {
    for (const a of args) {
      const m = /^cmd=(.*)$/i.exec(a);
      if (m) return m[1];
    }
    return null;
  }

  private replyAuthen(inPort: string, dstIp: IPAddress, request: TacacsPacket, username: string, password: string): void {
    const user = this.config.users.get(username);
    const status: TacacsAuthenStatus = user && user.password === password ? 'pass' : 'fail';
    const body: TacacsBody = {
      type: 'tacacs-authen-reply',
      status, flags: 0, serverMsg: status === 'pass' ? 'OK' : 'Authentication failed',
      data: '',
    };
    this.transmit(inPort, dstIp, request.header, 1, body);
    Logger.info(this.host.id, 'tacacs:authen-reply',
      `${this.host.name}: ${username}@${dstIp} → ${status}`);
  }

  private replyAuthor(inPort: string, dstIp: IPAddress, request: TacacsPacket, username: string, cmd: string | null): void {
    const user = this.config.users.get(username);
    let status: TacacsAuthorStatus;
    if (!user) status = 'fail';
    else if (cmd === null || user.permittedCommands.size === 0 || user.permittedCommands.has(cmd)) status = 'pass-add';
    else status = 'fail';
    const body: TacacsBody = {
      type: 'tacacs-author-reply',
      status, args: [], serverMsg: status === 'fail' ? 'Command denied' : '', data: '',
    };
    this.transmit(inPort, dstIp, request.header, 2, body);
  }

  private replyAcct(inPort: string, dstIp: IPAddress, request: TacacsPacket): void {
    const body: TacacsBody = {
      type: 'tacacs-acct-reply',
      status: 'success', serverMsg: '', data: '',
    };
    this.transmit(inPort, dstIp, request.header, 3, body);
  }

  private transmit(portName: string, dstIp: IPAddress, requestHeader: TacacsHeader, type: number, body: TacacsBody): void {
    const port = this.host.getPort(portName);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const header: TacacsHeader = {
      version: 0xc1, type, seqNo: requestHeader.seqNo + 1, flags: 0,
      sessionId: requestHeader.sessionId, length: 64,
    };
    const payload: TacacsPacket = { type: 'tacacs', header, body };
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: this.config.port,
      destinationPort: 49152 + (requestHeader.sessionId & 0x3fff),
      length: 8 + 64, checksum: 0, payload,
    };
    const ipPkt: IPv4Packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0,
      totalLength: 20 + udp.length,
      identification: nextIPv4Id(), flags: 0, fragmentOffset: 0,
      ttl: 64, protocol: IP_PROTO_UDP, headerChecksum: 0,
      sourceIP: srcIp, destinationIP: dstIp,
      payload: udp,
    };
    ipPkt.headerChecksum = computeIPv4Checksum(ipPkt);
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(), dstMAC: MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(portName, eth);
    this.getBus().publish({
      topic: 'tacacs.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(),
        sessionId: header.sessionId, bodyType: body.type,
      },
    });
  }
}

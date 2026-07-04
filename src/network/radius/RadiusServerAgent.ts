import type { IEventBus } from '@/events/EventBus';
import {
  type RadiusServerAgentConfig, type RadiusPacket, type RadiusUser,
  type RadiusAttribute,
  createDefaultServerConfig, attr, getAttr, makeAuthenticator,
  decryptUserPassword, isPrintablePassword,
  UDP_PORT_RADIUS_AUTH,
} from './types';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import type { Port } from '../hardware/Port';
import { Logger } from '../core/Logger';

export interface RadiusServerHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-resolved next-hop MAC, when known — falls back to broadcast otherwise (mirrors `TcpHost`). */
  resolveMac?(ip: string): MACAddress | null;
}

/** How long a served response is kept for retransmission dedup (RFC 2865 §2). */
const DEDUP_TTL_MS = 30_000;

export class RadiusServerAgent {
  private config: RadiusServerAgentConfig = createDefaultServerConfig();
  private running = false;
  /** Keyed by client IP:port:identifier:authenticator — replays the exact response instead of re-processing a retransmission. */
  private readonly recentReplies = new Map<string, { response: RadiusPacket; sentAt: number }>();

  constructor(
    private readonly host: RadiusServerHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  getConfig(): Readonly<RadiusServerAgentConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  setSharedSecret(secret: string): void { this.config.sharedSecret = secret; }

  addUser(username: string, password: string, attrs: RadiusAttribute[] = []): void {
    const user: RadiusUser = { username, password, replyAttributes: attrs };
    this.config.users.set(username, user);
  }

  removeUser(username: string): void { this.config.users.delete(username); }

  authorizeClient(clientIp: string): void { this.config.clients.add(clientIp); }
  revokeClient(clientIp: string): void { this.config.clients.delete(clientIp); }

  listUsers(): RadiusUser[] { return Array.from(this.config.users.values()); }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running || !this.config.enabled) return;
    if (udp.destinationPort !== this.config.port) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;
    if (payload.code !== 'access-request') return;

    const senderIp = srcIp.toString();
    const dedupKey = `${senderIp}:${udp.sourcePort}:${payload.identifier}:${payload.authenticator}`;
    this.pruneDedupCache();
    const cached = this.recentReplies.get(dedupKey);
    if (cached) {
      this.resend(inPort, srcIp, udp.sourcePort, cached.response);
      return;
    }

    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: senderIp, code: payload.code, identifier: payload.identifier,
      },
    });

    if (this.config.clients.size > 0 && !this.config.clients.has(senderIp)) {
      this.publishRejected(senderIp, getAttr(payload, 'user-name')?.value as string ?? '', 'client-not-authorized');
      return;
    }

    const usernameAttr = getAttr(payload, 'user-name');
    const passwordAttr = getAttr(payload, 'user-password');
    if (!usernameAttr || !passwordAttr) {
      this.publishRejected(senderIp, usernameAttr ? String(usernameAttr.value) : '', 'bad-password');
      return;
    }

    const username = String(usernameAttr.value);
    const encryptedPassword = String(passwordAttr.value);
    const decrypted = decryptUserPassword(encryptedPassword, this.config.sharedSecret, payload.authenticator);
    const user = this.config.users.get(username);
    const secretLooksWrong = !isPrintablePassword(decrypted);
    const accepted = !secretLooksWrong && !!user && user.password === decrypted;

    if (!accepted) {
      const reason: 'unknown-user' | 'bad-password' | 'bad-secret' =
        secretLooksWrong ? 'bad-secret' : !user ? 'unknown-user' : 'bad-password';
      this.publishRejected(senderIp, username, reason);
    }

    this.reply(inPort, srcIp, udp.sourcePort, payload, accepted, user, dedupKey);
  }

  private pruneDedupCache(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [key, entry] of this.recentReplies) {
      if (entry.sentAt < cutoff) this.recentReplies.delete(key);
    }
  }

  private publishRejected(fromIp: string, username: string,
                          reason: 'unknown-user' | 'bad-password' | 'bad-secret' | 'client-not-authorized'): void {
    this.getBus().publish({
      topic: 'radius.auth.rejected',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp, username, reason,
      },
    });
  }

  private reply(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    accepted: boolean, user: RadiusUser | undefined, dedupKey: string,
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const replyAttrs: RadiusAttribute[] = [];
    if (accepted && user?.replyAttributes) replyAttrs.push(...user.replyAttributes);
    if (!accepted) replyAttrs.push(attr('reply-message', 'Authentication failed'));
    const response: RadiusPacket = {
      type: 'radius',
      code: accepted ? 'access-accept' : 'access-reject',
      identifier: request.identifier,
      authenticator: makeAuthenticator(request.identifier ^ (Date.now() & 0xffff)),
      attributes: replyAttrs,
    };
    this.recentReplies.set(dedupKey, { response, sentAt: Date.now() });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, response);
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier,
        username: user?.username ?? null,
      },
    });
    Logger.info(this.host.id, 'radius:reply',
      `${this.host.name}: ${dstIp} ${response.code} for ${user?.username ?? '(unknown)'}`);
  }

  /** Retransmission of a request already answered: replay the cached response on the wire without re-processing (no duplicate accept/reject decision, no duplicate received/rejected events). */
  private resend(inPort: string, dstIp: IPAddress, clientPort: number, response: RadiusPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, response);
    Logger.info(this.host.id, 'radius:resend',
      `${this.host.name}: retransmission from ${dstIp} → cached ${response.code}`);
  }

  private sendRadiusFrame(
    inPort: string, port: Port, srcIp: IPAddress, dstIp: IPAddress,
    clientPort: number, response: RadiusPacket,
  ): void {
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: this.config.port,
      destinationPort: clientPort,
      length: 20 + 16, checksum: 0, payload: response,
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
      srcMAC: port.getMAC(),
      dstMAC: this.host.resolveMac?.(dstIp.toString()) ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(inPort, eth);
  }
}

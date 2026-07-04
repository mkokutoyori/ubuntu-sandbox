import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { hexToBytes } from '@/crypto/encoding';
import {
  type RadiusClientConfig, type RadiusServerConfig, type RadiusPacket,
  type RadiusAttribute,
  createDefaultClientConfig, defaultServerEntry, attr, getAttr,
  encryptUserPassword,
  UDP_PORT_RADIUS_AUTH,
} from './types';
import {
  randomRequestAuthenticator, withMessageAuthenticator,
  verifyResponseAuthenticator, verifyMessageAuthenticator,
} from './authenticators';
import { buildChapPasswordHex } from './passwords';
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
  /** ARP-resolved next-hop MAC, when known — falls back to broadcast otherwise (mirrors `TcpHost`). */
  resolveMac?(ip: string): MACAddress | null;
  /** Real RIB lookup (LPM) — falls back to same-subnet/first-up-port heuristics when unset. */
  resolveRoute?(targetIp: string): { iface: string; nextHopIp: string } | null;
}

type RadiusAuthMethod = 'pap' | 'chap';

interface PendingRequest {
  identifier: number;
  serverIp: string;
  username: string;
  password: string;
  authMethod: RadiusAuthMethod;
  /** Request Authenticator sent with this identifier — reused verbatim across retransmissions (RFC 2865 §3) so the server's dedup cache recognizes them. */
  authenticator: string;
  secret: string;
  /** State (24) to echo back — set when this request is a reply to a previous Access-Challenge. */
  state: string | null;
  /** How many more Access-Challenge round-trips this request will still follow before giving up. */
  challengesLeft: number;
  resolve: (accepted: boolean) => void;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

const DEFAULT_MAX_CHALLENGE_ROUNDS = 1;

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

  /** PAP authentication (RFC 2865 §5.2 User-Password). */
  authenticate(username: string, password: string, serverIp?: string): Promise<boolean> {
    return this.run(username, password, 'pap', serverIp);
  }

  /** CHAP authentication (RFC 2865 §5.3, RFC 1994). */
  authenticateChap(username: string, password: string, serverIp?: string): Promise<boolean> {
    return this.run(username, password, 'chap', serverIp);
  }

  private run(username: string, password: string, authMethod: RadiusAuthMethod, serverIp?: string): Promise<boolean> {
    if (!this.config.enabled) return Promise.resolve(false);
    const server = serverIp
      ? this.config.servers.find((s) => s.ip === serverIp)
      : this.config.servers[0];
    if (!server) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.beginRequest(server, username, password, authMethod, null, DEFAULT_MAX_CHALLENGE_ROUNDS, resolve);
    });
  }

  private beginRequest(
    server: RadiusServerConfig, username: string, password: string, authMethod: RadiusAuthMethod,
    state: string | null, challengesLeft: number, resolve: (accepted: boolean) => void,
  ): void {
    const identifier = this.nextIdentifier;
    this.nextIdentifier = (this.nextIdentifier + 1) & 0xff;
    const authenticator = randomRequestAuthenticator();
    const pending: PendingRequest = {
      identifier, serverIp: server.ip, username, password, authMethod,
      authenticator, secret: server.sharedSecret, state, challengesLeft,
      resolve, timer: null,
      attemptsLeft: server.retransmit,
    };
    this.pending.set(identifier, pending);
    this.transmit(server, pending);
    this.armTimeout(server, pending);
  }

  handleUdp(_inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.config.enabled) return;
    if (udp.sourcePort !== UDP_PORT_RADIUS_AUTH && udp.destinationPort !== UDP_PORT_RADIUS_AUTH) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;
    if (payload.code !== 'access-accept' && payload.code !== 'access-reject' && payload.code !== 'access-challenge') return;
    const pending = this.pending.get(payload.identifier);
    if (!pending) return;
    if (pending.serverIp !== srcIp.toString()) return;

    if (!verifyResponseAuthenticator(payload, pending.authenticator, pending.secret)) {
      Logger.warn(this.host.id, 'radius:bad-response-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} for ${pending.username} — invalid Response Authenticator`);
      return; // silently ignored (RFC 2865 §3) — retransmission/timeout proceeds as if nothing arrived
    }
    if (!verifyMessageAuthenticator(payload, pending.authenticator, pending.secret)) {
      Logger.warn(this.host.id, 'radius:bad-message-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} for ${pending.username} — invalid Message-Authenticator`);
      return;
    }

    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), code: payload.code, identifier: payload.identifier,
      },
    });

    if (payload.code === 'access-challenge') {
      this.continueChallenge(payload, pending);
      return;
    }

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

  /** RFC 2865 §4.4: reply to an Access-Challenge with a fresh Access-Request carrying the received State. */
  private continueChallenge(payload: RadiusPacket, pending: PendingRequest): void {
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pending.delete(pending.identifier);

    const stateAttr = getAttr(payload, 'state');
    const state = stateAttr ? String(stateAttr.value) : null;
    const giveUp = (reason: string) => {
      pending.resolve(false);
      this.getBus().publish({
        topic: 'radius.auth.completed',
        payload: {
          deviceId: this.host.id, hostname: this.host.getHostname(),
          serverIp: pending.serverIp, username: pending.username,
          accepted: false, identifier: payload.identifier, reason,
        },
      });
    };
    if (!state || pending.challengesLeft <= 0) {
      giveUp(!state ? 'bad-challenge' : 'too-many-challenges');
      return;
    }
    const server = this.config.servers.find((s) => s.ip === pending.serverIp);
    if (!server) { giveUp('no-server'); return; }
    this.beginRequest(
      server, pending.username, pending.password, pending.authMethod,
      state, pending.challengesLeft - 1, pending.resolve,
    );
  }

  private armTimeout(server: RadiusServerConfig, pending: PendingRequest): void {
    const s = this.getScheduler();
    this.scheduler = s;
    pending.timer = s.setTimeout(() => {
      if (!this.pending.has(pending.identifier)) return;
      if (pending.attemptsLeft > 0) {
        pending.attemptsLeft--;
        this.transmit(server, pending);
        this.armTimeout(server, pending);
      } else {
        this.pending.delete(pending.identifier);
        pending.resolve(false);
        this.getBus().publish({
          topic: 'radius.auth.completed',
          payload: {
            deviceId: this.host.id, hostname: this.host.getHostname(),
            serverIp: server.ip, username: pending.username,
            accepted: false, identifier: pending.identifier, reason: 'timeout',
          },
        });
      }
    }, server.timeoutMs);
  }

  private transmit(server: RadiusServerConfig, pending: PendingRequest): void {
    const egress = this.resolveEgress(server.ip);
    if (!egress) return;
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) return;
    const attrs: RadiusAttribute[] = [attr('user-name', pending.username)];
    if (pending.authMethod === 'chap') {
      const challenge = hexToBytes(pending.authenticator);
      const chapId = pending.identifier & 0xff;
      attrs.push(attr('chap-password', buildChapPasswordHex(chapId, pending.password, challenge)));
      attrs.push(attr('chap-challenge', pending.authenticator));
    } else {
      attrs.push(attr('user-password', encryptUserPassword(pending.password, server.sharedSecret, pending.authenticator)));
    }
    attrs.push(attr('nas-ip-address', srcIp.toString()));
    if (pending.state) attrs.push(attr('state', pending.state));
    if (this.config.nasIdentifier) attrs.push(attr('nas-identifier', this.config.nasIdentifier));
    let payload: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: pending.identifier,
      authenticator: pending.authenticator,
      attributes: attrs,
    };
    payload = withMessageAuthenticator(payload, pending.authenticator, server.sharedSecret);
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort: 49152 + (pending.identifier & 0x3fff),
      destinationPort: server.authPort,
      length: 20 + 32 + pending.username.length + pending.password.length,
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
      dstMAC: this.host.resolveMac?.(server.ip) ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    // Published before the actual send: delivery is synchronous, so a
    // multi-round exchange (e.g. an Access-Challenge round-trip) can run to
    // completion *inside* this call — publishing after would report this
    // request's own "sent" event only once everything it triggered is done.
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: server.ip, code: 'access-request',
        identifier: pending.identifier, username: pending.username,
      },
    });
    this.host.sendFrame(egress.name, eth);
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
    if (this.config.sourceInterface) {
      const p = this.host.getPort(this.config.sourceInterface);
      if (p) return { name: this.config.sourceInterface, port: p };
    }
    if (this.host.resolveRoute) {
      const route = this.host.resolveRoute(targetIp);
      if (route) {
        const port = this.host.getPort(route.iface);
        if (port && port.getIsUp()) return { name: route.iface, port };
      }
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

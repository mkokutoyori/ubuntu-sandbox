import type { IEventBus } from '@/events/EventBus';
import { hexToBytes } from '@/crypto/encoding';
import {
  type RadiusServerAgentConfig, type RadiusPacket, type RadiusUser,
  type RadiusAttribute,
  createDefaultServerConfig, attr, getAttr,
  decryptUserPassword, isPrintablePassword,
  UDP_PORT_RADIUS_AUTH,
} from './types';
import {
  verifyMessageAuthenticator, withMessageAuthenticator, withResponseAuthenticator,
  randomOpaqueToken,
} from './authenticators';
import { parseChapPasswordHex, verifyChapResponse } from './passwords';
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
/** How long an issued Access-Challenge's State stays redeemable (RFC 2865 §4.4). */
const CHALLENGE_TTL_MS = 60_000;

type RejectReason = 'unknown-user' | 'bad-password' | 'bad-secret' | 'client-not-authorized';

export class RadiusServerAgent {
  private config: RadiusServerAgentConfig = createDefaultServerConfig();
  private running = false;
  /** Keyed by client IP:port:identifier:authenticator — replays the exact response instead of re-processing a retransmission. */
  private readonly recentReplies = new Map<string, { response: RadiusPacket; sentAt: number }>();
  /** Keyed by the opaque State value handed out with an Access-Challenge — redeemed exactly once. */
  private readonly challenges = new Map<string, { username: string; expiresAt: number }>();

  constructor(
    private readonly host: RadiusServerHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  getConfig(): Readonly<RadiusServerAgentConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  setSharedSecret(secret: string): void { this.config.sharedSecret = secret; }

  addUser(
    username: string, password: string, attrs: RadiusAttribute[] = [],
    opts: { challenge?: { prompt: string } } = {},
  ): void {
    const user: RadiusUser = { username, password, replyAttributes: attrs, challenge: opts.challenge };
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

    if (!verifyMessageAuthenticator(payload, payload.authenticator, this.config.sharedSecret)) {
      Logger.warn(this.host.id, 'radius:bad-message-authenticator',
        `${this.host.name}: dropped Access-Request from ${srcIp} — invalid Message-Authenticator`);
      return; // RFC 3579 §3.2 — silently discarded, no reply, no event
    }

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
    if (!usernameAttr) {
      this.publishRejected(senderIp, '', 'bad-password');
      return;
    }
    const username = String(usernameAttr.value);
    const user = this.config.users.get(username);

    // RFC 2865 §4.4: a State means this request is the answer to a challenge
    // we issued; redeem it before falling through to the normal PAP/CHAP
    // check below. No State + a challenge-configured user means issue one
    // instead of deciding accept/reject on this round.
    const stateAttr = getAttr(payload, 'state');
    const incomingState = stateAttr ? String(stateAttr.value) : null;
    if (incomingState) {
      this.pruneChallenges();
      const ctx = this.challenges.get(incomingState);
      this.challenges.delete(incomingState); // one-shot
      if (!ctx || ctx.username !== username) {
        this.publishRejected(senderIp, username, 'bad-password');
        this.reply(inPort, srcIp, udp.sourcePort, payload, false, user, dedupKey);
        return;
      }
    } else if (user?.challenge) {
      this.issueChallenge(inPort, srcIp, udp.sourcePort, payload, user, dedupKey);
      return;
    }

    const chapAttr = getAttr(payload, 'chap-password');
    const passwordAttr = getAttr(payload, 'user-password');
    if (!chapAttr && !passwordAttr) {
      this.publishRejected(senderIp, username, 'bad-password');
      return;
    }

    let accepted: boolean;
    let reason: RejectReason;
    if (chapAttr) {
      const parsed = parseChapPasswordHex(String(chapAttr.value));
      const challengeAttr = getAttr(payload, 'chap-challenge');
      const challenge = challengeAttr ? hexToBytes(String(challengeAttr.value)) : hexToBytes(payload.authenticator);
      accepted = !!parsed && !!user && verifyChapResponse(parsed.chapIdentifier, parsed.response, user.password, challenge);
      reason = !user ? 'unknown-user' : 'bad-password';
    } else {
      const decrypted = decryptUserPassword(String(passwordAttr!.value), this.config.sharedSecret, payload.authenticator);
      const secretLooksWrong = !isPrintablePassword(decrypted);
      accepted = !secretLooksWrong && !!user && user.password === decrypted;
      reason = secretLooksWrong ? 'bad-secret' : !user ? 'unknown-user' : 'bad-password';
    }

    if (!accepted) this.publishRejected(senderIp, username, reason);
    this.reply(inPort, srcIp, udp.sourcePort, payload, accepted, user, dedupKey);
  }

  private pruneDedupCache(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [key, entry] of this.recentReplies) {
      if (entry.sentAt < cutoff) this.recentReplies.delete(key);
    }
  }

  private pruneChallenges(): void {
    const now = Date.now();
    for (const [key, entry] of this.challenges) {
      if (entry.expiresAt < now) this.challenges.delete(key);
    }
  }

  private publishRejected(fromIp: string, username: string, reason: RejectReason): void {
    this.getBus().publish({
      topic: 'radius.auth.rejected',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp, username, reason,
      },
    });
  }

  /** RFC 2865 §4.4: answer with Access-Challenge instead of a final decision, and remember the State so the next round can be redeemed. */
  private issueChallenge(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    user: RadiusUser, dedupKey: string,
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const state = randomOpaqueToken(16);
    this.challenges.set(state, { username: user.username, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    let response: RadiusPacket = {
      type: 'radius', code: 'access-challenge', identifier: request.identifier,
      authenticator: '00'.repeat(16),
      attributes: [attr('state', state), attr('reply-message', user.challenge!.prompt)],
    };
    response = withMessageAuthenticator(response, request.authenticator, this.config.sharedSecret);
    response = withResponseAuthenticator(response, request.authenticator, this.config.sharedSecret);
    this.recentReplies.set(dedupKey, { response, sentAt: Date.now() });
    // Published before the actual send: delivery is synchronous, so the
    // client may run the rest of the challenge round-trip to completion
    // *inside* this call — publishing after would report this challenge's
    // own "sent" event only once everything it triggered is done.
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier, username: user.username,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, response);
    Logger.info(this.host.id, 'radius:challenge',
      `${this.host.name}: ${dstIp} Access-Challenge for ${user.username}`);
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
    let response: RadiusPacket = {
      type: 'radius',
      code: accepted ? 'access-accept' : 'access-reject',
      identifier: request.identifier,
      authenticator: '00'.repeat(16), // placeholder — replaced below once Message-Authenticator is finalized
      attributes: replyAttrs,
    };
    // RFC 2869 §5.14: Message-Authenticator must be computed and folded in
    // before the Response Authenticator itself is computed over the packet.
    response = withMessageAuthenticator(response, request.authenticator, this.config.sharedSecret);
    response = withResponseAuthenticator(response, request.authenticator, this.config.sharedSecret);
    this.recentReplies.set(dedupKey, { response, sentAt: Date.now() });
    // Published before the actual send — see the comment in issueChallenge().
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier,
        username: user?.username ?? null,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, response);
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

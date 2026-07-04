import type { IEventBus } from '@/events/EventBus';
import { hexToBytes } from '@/crypto/encoding';
import {
  type RadiusServerAgentConfig, type RadiusPacket, type RadiusUser,
  type RadiusAttribute,
  createDefaultServerConfig, attr, getAttr,
  decryptUserPassword, isPrintablePassword,
} from './types';
import {
  verifyMessageAuthenticator, withMessageAuthenticator, withResponseAuthenticator,
  randomOpaqueToken, verifyAccountingRequestAuthenticator,
} from './authenticators';
import { parseChapPasswordHex, verifyChapResponse } from './passwords';
import {
  ACCT_STATUS_TYPE, ACCT_TERMINATE_CAUSE, type AcctStatusType, type AcctTerminateCause,
} from './accounting';
import { type EapPacket, eapPacketFromWireHex, eapPacketToWireHex, verifyEapMd5Response } from './eap';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
  IP_PROTO_UDP, ETHERTYPE_IPV4, nextIPv4Id, computeIPv4Checksum,
} from '../core/types';
import type { Port } from '../hardware/Port';
import { Logger } from '../core/Logger';

const ACCT_STATUS_BY_NUMBER = new Map<number, AcctStatusType>(
  (Object.keys(ACCT_STATUS_TYPE) as AcctStatusType[]).map((k) => [ACCT_STATUS_TYPE[k], k]),
);
const ACCT_TERMINATE_CAUSE_BY_NUMBER = new Map<number, AcctTerminateCause>(
  (Object.keys(ACCT_TERMINATE_CAUSE) as AcctTerminateCause[]).map((k) => [ACCT_TERMINATE_CAUSE[k], k]),
);

export interface AcctSessionRecord {
  sessionId: string;
  username: string;
  nasIp: string;
  status: AcctStatusType;
  startedAt: number;
  updatedAt: number;
  sessionTimeSec: number;
  inputOctets: number;
  outputOctets: number;
  terminateCause?: AcctTerminateCause;
}

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
  /** Accounting dedup cache, same shape/purpose as recentReplies but for Accounting-Request/Response. */
  private readonly recentAcctReplies = new Map<string, { response: RadiusPacket; sentAt: number }>();
  /** Accounting journal, keyed by Acct-Session-Id — last known state per session (Start → Interim-Update* → Stop). */
  private readonly acctSessions = new Map<string, AcctSessionRecord>();
  /** EAP-MD5 relay sessions (RFC 3579), keyed by the opaque State handed out with the Access-Challenge carrying the MD5 challenge. */
  private readonly eapSessions = new Map<string, { username: string; challengeHex: string; expiresAt: number }>();

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

  /** Accounting journal — last known state per Acct-Session-Id (RFC 2866). */
  listAccountingSessions(): AcctSessionRecord[] { return Array.from(this.acctSessions.values()); }

  /** RFC 2866: Accounting-Request/Response on the accounting port (default UDP/1813). */
  handleAcctUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running || !this.config.enabled) return;
    if (udp.destinationPort !== this.config.acctPort) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius' || payload.code !== 'accounting-request') return;

    if (!verifyAccountingRequestAuthenticator(payload, this.config.sharedSecret)) {
      Logger.warn(this.host.id, 'radius:bad-accounting-authenticator',
        `${this.host.name}: dropped Accounting-Request from ${srcIp} — invalid Authenticator (shared secret mismatch?)`);
      return;
    }

    const senderIp = srcIp.toString();
    const dedupKey = `acct:${senderIp}:${udp.sourcePort}:${payload.identifier}:${payload.authenticator}`;
    this.pruneAcctDedupCache();
    const cached = this.recentAcctReplies.get(dedupKey);
    if (cached) {
      this.resendAcct(inPort, srcIp, udp.sourcePort, cached.response);
      return;
    }

    const sessionIdAttr = getAttr(payload, 'acct-session-id');
    const usernameAttr = getAttr(payload, 'user-name');
    const statusAttr = getAttr(payload, 'acct-status-type');
    if (!sessionIdAttr || !usernameAttr || !statusAttr) return; // malformed — nothing sane to journal or ack
    const status = ACCT_STATUS_BY_NUMBER.get(Number(statusAttr.value));
    if (status !== 'start' && status !== 'interim-update' && status !== 'stop') return;

    const sessionId = String(sessionIdAttr.value);
    const username = String(usernameAttr.value);
    const nasIp = String(getAttr(payload, 'nas-ip-address')?.value ?? senderIp);
    const sessionTimeSec = Number(getAttr(payload, 'acct-session-time')?.value ?? 0);
    const inputOctets = Number(getAttr(payload, 'acct-input-octets')?.value ?? 0);
    const outputOctets = Number(getAttr(payload, 'acct-output-octets')?.value ?? 0);
    const terminateCauseAttr = getAttr(payload, 'acct-terminate-cause');
    const terminateCause = terminateCauseAttr
      ? ACCT_TERMINATE_CAUSE_BY_NUMBER.get(Number(terminateCauseAttr.value)) : undefined;

    const now = Date.now();
    const existing = this.acctSessions.get(sessionId);
    this.acctSessions.set(sessionId, {
      sessionId, username, nasIp, status,
      startedAt: status === 'start' ? now : (existing?.startedAt ?? now),
      updatedAt: now, sessionTimeSec, inputOctets, outputOctets, terminateCause,
    });

    this.getBus().publish({
      topic: 'radius.accounting.record',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        serverIp: senderIp, sessionId, username, status,
        sessionTimeSec, inputOctets, outputOctets,
        terminateCause: terminateCause ?? null,
      },
    });
    Logger.info(this.host.id, 'radius:accounting',
      `${this.host.name}: ${status} for ${username} (session ${sessionId})`);

    this.replyAcct(inPort, srcIp, udp.sourcePort, payload, dedupKey);
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running || !this.config.enabled) return;
    if (udp.destinationPort !== this.config.port) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;
    if (payload.code !== 'access-request') return;

    const eapAttr = getAttr(payload, 'eap-message');
    if (eapAttr && !getAttr(payload, 'message-authenticator')) {
      Logger.warn(this.host.id, 'radius:missing-message-authenticator',
        `${this.host.name}: dropped Access-Request from ${srcIp} — EAP-Message without Message-Authenticator (RFC 3579 §3.2)`);
      return;
    }
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

    if (eapAttr) {
      this.handleEapRequest(inPort, srcIp, udp.sourcePort, payload, username, user, dedupKey);
      return;
    }

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

  private pruneAcctDedupCache(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [key, entry] of this.recentAcctReplies) {
      if (entry.sentAt < cutoff) this.recentAcctReplies.delete(key);
    }
  }

  private pruneEapSessions(): void {
    const now = Date.now();
    for (const [key, entry] of this.eapSessions) {
      if (entry.expiresAt < now) this.eapSessions.delete(key);
    }
  }

  /**
   * EAP relayed over RADIUS (RFC 3579): the request carries an EAP-Message
   * instead of (or alongside) User-Password/CHAP-Password. EAP-MD5 is
   * structurally CHAP (RFC 3748 §4.2) — the challenge/response math is
   * shared with `passwords.ts` via `eap.ts`'s wrappers.
   */
  private handleEapRequest(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    username: string, user: RadiusUser | undefined, dedupKey: string,
  ): void {
    const eapAttr = getAttr(request, 'eap-message')!;
    const eap = eapPacketFromWireHex(String(eapAttr.value));
    if (!eap) return; // malformed EAP-Message — nothing sane to answer

    const stateAttr = getAttr(request, 'state');
    const incomingState = stateAttr ? String(stateAttr.value) : null;

    if (eap.code === 'response' && eap.eapType === 'identity' && !incomingState) {
      if (!user) {
        this.publishRejected(dstIp.toString(), username, 'unknown-user');
        this.replyEap(inPort, dstIp, clientPort, request, { type: 'eap', code: 'failure', identifier: eap.identifier }, false, undefined, dedupKey);
        return;
      }
      const challengeHex = randomOpaqueToken(16);
      const state = randomOpaqueToken(16);
      const eapIdentifier = (eap.identifier + 1) & 0xff;
      this.eapSessions.set(state, { username, challengeHex, expiresAt: Date.now() + CHALLENGE_TTL_MS });
      const eapRequest: EapPacket = {
        type: 'eap', code: 'request', identifier: eapIdentifier,
        eapType: 'md5-challenge', md5Challenge: challengeHex,
      };
      this.replyEapChallenge(inPort, dstIp, clientPort, request, eapRequest, state, dedupKey);
      return;
    }

    if (eap.code === 'response' && eap.eapType === 'md5-challenge' && incomingState) {
      this.pruneEapSessions();
      const session = this.eapSessions.get(incomingState);
      this.eapSessions.delete(incomingState); // one-shot
      const sessionOk = !!session && session.username === username;
      const accepted = sessionOk && !!user && !!eap.md5Response
        && verifyEapMd5Response(eap.identifier, eap.md5Response, user.password, session!.challengeHex);
      if (!accepted) this.publishRejected(dstIp.toString(), username, !user ? 'unknown-user' : 'bad-password');
      this.replyEap(
        inPort, dstIp, clientPort, request,
        { type: 'eap', code: accepted ? 'success' : 'failure', identifier: eap.identifier },
        accepted, user, dedupKey,
      );
      return;
    }

    // Unrecognized shape mid-conversation (e.g. Nak, replayed Identity with a
    // stale State) — fail cleanly instead of leaving the supplicant hanging.
    this.replyEap(inPort, dstIp, clientPort, request, { type: 'eap', code: 'failure', identifier: eap.identifier }, false, user, dedupKey);
  }

  /** Access-Challenge carrying an EAP-Request (RFC 3579 §3.1) — always Message-Authenticator-signed. */
  private replyEapChallenge(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    eapRequest: EapPacket, state: string, dedupKey: string,
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    let response: RadiusPacket = {
      type: 'radius', code: 'access-challenge', identifier: request.identifier,
      authenticator: '00'.repeat(16),
      attributes: [attr('eap-message', eapPacketToWireHex(eapRequest)), attr('state', state)],
    };
    response = withMessageAuthenticator(response, request.authenticator, this.config.sharedSecret);
    response = withResponseAuthenticator(response, request.authenticator, this.config.sharedSecret);
    this.recentReplies.set(dedupKey, { response, sentAt: Date.now() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier, username: null,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.port, response);
    Logger.info(this.host.id, 'radius:eap', `${this.host.name}: ${dstIp} EAP-Request/MD5-Challenge issued`);
  }

  /** Final Access-Accept/Reject carrying EAP-Success/Failure, plus any authorization attributes on accept. */
  private replyEap(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    eapResult: EapPacket, accepted: boolean, user: RadiusUser | undefined, dedupKey: string,
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const attrs: RadiusAttribute[] = [attr('eap-message', eapPacketToWireHex(eapResult))];
    if (accepted && user?.replyAttributes) attrs.push(...user.replyAttributes);
    let response: RadiusPacket = {
      type: 'radius', code: accepted ? 'access-accept' : 'access-reject', identifier: request.identifier,
      authenticator: '00'.repeat(16), attributes: attrs,
    };
    response = withMessageAuthenticator(response, request.authenticator, this.config.sharedSecret);
    response = withResponseAuthenticator(response, request.authenticator, this.config.sharedSecret);
    this.recentReplies.set(dedupKey, { response, sentAt: Date.now() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier, username: user?.username ?? null,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.port, response);
    Logger.info(this.host.id, 'radius:eap',
      `${this.host.name}: ${dstIp} ${response.code} (EAP-${eapResult.code}) for ${user?.username ?? '(unknown)'}`);
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
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.port, response);
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
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.port, response);
    Logger.info(this.host.id, 'radius:reply',
      `${this.host.name}: ${dstIp} ${response.code} for ${user?.username ?? '(unknown)'}`);
  }

  /** Retransmission of a request already answered: replay the cached response on the wire without re-processing (no duplicate accept/reject decision, no duplicate received/rejected events). */
  private resend(inPort: string, dstIp: IPAddress, clientPort: number, response: RadiusPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.port, response);
    Logger.info(this.host.id, 'radius:resend',
      `${this.host.name}: retransmission from ${dstIp} → cached ${response.code}`);
  }

  /** RFC 2866 §3: Accounting-Response, signed with the plain Response Authenticator (no Message-Authenticator). */
  private replyAcct(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket, dedupKey: string,
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    let response: RadiusPacket = {
      type: 'radius', code: 'accounting-response', identifier: request.identifier,
      authenticator: '00'.repeat(16), attributes: [],
    };
    response = withResponseAuthenticator(response, request.authenticator, this.config.sharedSecret);
    this.recentAcctReplies.set(dedupKey, { response, sentAt: Date.now() });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.acctPort, response);
  }

  private resendAcct(inPort: string, dstIp: IPAddress, clientPort: number, response: RadiusPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.acctPort, response);
    Logger.info(this.host.id, 'radius:resend',
      `${this.host.name}: accounting retransmission from ${dstIp} → cached ${response.code}`);
  }

  private sendRadiusFrame(
    inPort: string, port: Port, srcIp: IPAddress, dstIp: IPAddress,
    clientPort: number, sourcePort: number, response: RadiusPacket,
  ): void {
    const udp: UDPPacket = {
      type: 'udp',
      sourcePort,
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

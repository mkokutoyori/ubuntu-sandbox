import type { IEventBus } from '@/events/EventBus';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@/crypto/encoding';
import { md4 } from '@/crypto/hash';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type RadiusServerAgentConfig, type RadiusPacket, type RadiusUser,
  type RadiusAttribute,
  createDefaultServerConfig, attr, getAttr, getVsa,
  decryptUserPassword, encryptUserPassword, isPrintablePassword,
} from './types';
import {
  verifyMessageAuthenticator, withMessageAuthenticator, withResponseAuthenticator,
  randomOpaqueToken, randomRequestAuthenticator, verifyResponseAuthenticator,
  verifyAccountingRequestAuthenticator,
} from './authenticators';
import { parseChapPasswordHex, verifyChapResponse } from './passwords';
import {
  ACCT_STATUS_TYPE, ACCT_TERMINATE_CAUSE, type AcctStatusType, type AcctTerminateCause,
} from './accounting';
import { type EapPacket, eapPacketFromWireHex, eapPacketToWireHex, verifyEapMd5Response } from './eap';
import { MICROSOFT_VENDOR_ID } from './dictionary';
import {
  ntPasswordHash, generateNtResponse, generateAuthenticatorResponse,
  deriveMppeKeys, encryptMppeKey,
} from './mschapv2';
import { EapTlsServerSession } from './eaptls/EapTlsServerSession';
import type { EapTlsConfig } from './eaptls/EapTlsConfig';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type UDPPacket,
  ETHERTYPE_IPV4,
} from '../core/types';
import type { Port } from '../hardware/Port';
import { Logger } from '../core/Logger';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';

/** RFC 2548 §2.4.1 — Salt only needs to be unique-ish per attribute; `encryptMppeKey` forces its top bit to 1. */
function randomSalt(): number {
  return Math.floor(Math.random() * 0x10000);
}

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
  /** Real RIB lookup (LPM) — needed to reach a proxy realm's home server on another subnet (mirrors `RadiusClientHost`). */
  resolveRoute?(targetIp: string): { iface: string; nextHopIp: string } | null;
}

/** How long a served response is kept for retransmission dedup (RFC 2865 §2). */
const DEDUP_TTL_MS = 30_000;
/** How long an issued Access-Challenge's State stays redeemable (RFC 2865 §4.4). */
const CHALLENGE_TTL_MS = 60_000;

type RejectReason = 'unknown-user' | 'bad-password' | 'bad-secret' | 'client-not-authorized';

/** RFC 2607 — a realm this server proxies to a home server instead of authenticating locally. */
interface RealmRoute {
  homeServerIp: string;
  homePort: number;
  homeSecret: string;
  timeoutMs: number;
}

/** Context kept while an Access-Request forwarded to a realm's home server is in flight. */
interface PendingProxyContext {
  nasInPort: string;
  nasIp: string;
  nasPort: number;
  originalIdentifier: number;
  originalAuthenticator: string;
  nasSecret: string;
  homeServerIp: string;
  homePort: number;
  homeSecret: string;
  outAuthenticator: string;
  dedupKey: string;
  timer: TimerHandle | null;
}

/** Extra context a `setUserResolver` callback may need beyond the username itself. */
export interface RadiusUserResolverContext {
  /** The requesting NAS's source IP, as seen on this Access-Request. */
  nasIp: string;
}

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
  /** RFC 5216 EAP-TLS sessions, keyed by the (single, reused-for-the-whole-conversation) opaque State. Only one EAP method is offered per server — no NAK negotiation — selected by whether `eapTlsConfig` is set. */
  private readonly eapTlsSessions = new Map<string, { session: EapTlsServerSession; username: string; expiresAt: number }>();
  private eapTlsConfig: EapTlsConfig | null = null;
  /** RFC 2607 §2 — realm → home-server route, keyed by the realm suffix in `user@realm`. */
  private readonly realms = new Map<string, RealmRoute>();
  /** Forwarded Access-Requests awaiting the home server's Access-Accept/Reject, keyed by the identifier this proxy issued to the home server (its own space, distinct from the NAS's). */
  private readonly pendingProxy = new Map<number, PendingProxyContext>();
  private nextProxyIdentifier = 1;

  constructor(
    private readonly host: RadiusServerHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void {
    this.running = false;
    for (const ctx of this.pendingProxy.values()) {
      if (ctx.timer !== null) this.getScheduler().clear(ctx.timer);
    }
    this.pendingProxy.clear();
  }

  getConfig(): Readonly<RadiusServerAgentConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  setSharedSecret(secret: string): void { this.config.sharedSecret = secret; }

  /** RFC 5216 EAP-TLS / PEAP / RFC 5281 EAP-TTLS — when set, an Access-Request's EAP-Response/Identity starts a TLS-tunnel conversation instead of EAP-MD5 (no NAK negotiation between methods: exactly one is offered, chosen by `config.eapType`, default 'tls'). PEAP/EAP-TTLS additionally need `config.innerAuth` (see `InnerAuth.ts`) — without it they'd behave like plain EAP-TLS under a different wire type. `null` restores EAP-MD5 (the default). */
  setEapTlsConfig(config: EapTlsConfig | null): void { this.eapTlsConfig = config; }

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

  /**
   * RFC 2607 — proxy every `user@realm` request to a home server instead of
   * authenticating it locally. Scoped to PAP/CHAP only (both survive a hop:
   * CHAP-Password doesn't depend on the RADIUS shared secret at all, and
   * User-Password is decrypted with this server's NAS-facing secret then
   * re-encrypted with the home server's) — no EAP or Access-Challenge
   * proxying, no accounting proxying.
   */
  addRealm(realm: string, homeServerIp: string, homeSecret: string, opts: { port?: number; timeoutMs?: number } = {}): void {
    this.realms.set(realm, {
      homeServerIp, homeSecret,
      homePort: opts.port ?? this.config.port,
      timeoutMs: opts.timeoutMs ?? 2000,
    });
  }

  removeRealm(realm: string): void { this.realms.delete(realm); }
  listRealms(): Array<{ realm: string } & RealmRoute> {
    return Array.from(this.realms.entries()).map(([realm, route]) => ({ realm, ...route }));
  }

  /** External user store lookup (e.g. Windows NPS resolving against the SAM/AD directory), tried when `username` isn't in the static `addUser` table — RFC 2865 doesn't mandate a static user list; this keeps that model without hosts needing to mirror a live directory into it. The optional `context` (currently just the requesting NAS's IP) lets a resolver evaluate conditions that need to know who's asking — e.g. NPS Connection Request Policies (PRD-Windows-Server-Advanced.md §5 P22) keyed on NAS identity. */
  private userResolver: ((username: string, context?: RadiusUserResolverContext) => RadiusUser | undefined) | null = null;
  setUserResolver(fn: ((username: string, context?: RadiusUserResolverContext) => RadiusUser | undefined) | null): void { this.userResolver = fn; }

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

    if ((payload.code === 'access-accept' || payload.code === 'access-reject') && this.pendingProxy.size > 0) {
      if (this.tryCompleteProxyReply(srcIp, udp, payload)) return;
    }
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

    const realm = this.extractRealm(username);
    const realmRoute = realm ? this.realms.get(realm) : undefined;
    if (realm && realmRoute) {
      this.forwardToRealm(inPort, srcIp, udp.sourcePort, payload, username, realm, realmRoute, dedupKey);
      return;
    }

    const user = this.config.users.get(username) ?? this.userResolver?.(username, { nasIp: senderIp });

    if (eapAttr) {
      this.handleEapRequest(inPort, srcIp, udp.sourcePort, payload, username, user, dedupKey);
      return;
    }

    const msChap2ResponseVsa = getVsa(payload, MICROSOFT_VENDOR_ID, 25);
    if (msChap2ResponseVsa) {
      this.handleMsChapV2Request(inPort, srcIp, udp.sourcePort, payload, username, user, msChap2ResponseVsa, dedupKey);
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
      if (this.eapTlsConfig) {
        const session = new EapTlsServerSession(this.eapTlsConfig);
        const state = randomOpaqueToken(16);
        const eapIdentifier = (eap.identifier + 1) & 0xff;
        this.eapTlsSessions.set(state, { session, username, expiresAt: Date.now() + CHALLENGE_TTL_MS });
        this.replyEapChallenge(inPort, dstIp, clientPort, request, session.start(eapIdentifier), state, dedupKey);
        return;
      }
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

    if (eap.code === 'response'
        && (eap.eapType === 'tls' || eap.eapType === 'peap' || eap.eapType === 'ttls')
        && incomingState) {
      this.handleEapTlsResponse(inPort, dstIp, clientPort, request, username, eap, incomingState, dedupKey);
      return;
    }

    // Unrecognized shape mid-conversation (e.g. Nak, replayed Identity with a
    // stale State) — fail cleanly instead of leaving the supplicant hanging.
    this.replyEap(inPort, dstIp, clientPort, request, { type: 'eap', code: 'failure', identifier: eap.identifier }, false, user, dedupKey);
  }

  private pruneEapTlsSessions(): void {
    const now = Date.now();
    for (const [key, entry] of this.eapTlsSessions) {
      if (entry.expiresAt < now) this.eapTlsSessions.delete(key);
    }
  }

  /** RFC 5216 — one round of an ongoing EAP-TLS conversation: unlike EAP-MD5's single challenge/response, this can take many rounds (fragmentation both ways), all sharing the same State. */
  private handleEapTlsResponse(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    username: string, eap: EapPacket, state: string, dedupKey: string,
  ): void {
    this.pruneEapTlsSessions();
    const ctx = this.eapTlsSessions.get(state);
    if (!ctx) {
      this.replyEap(inPort, dstIp, clientPort, request, { type: 'eap', code: 'failure', identifier: eap.identifier }, false, undefined, dedupKey);
      return;
    }
    ctx.expiresAt = Date.now() + CHALLENGE_TTL_MS;
    const nextRequest = ctx.session.handle(eap);
    if (ctx.session.result === null) {
      this.replyEapChallenge(inPort, dstIp, clientPort, request, nextRequest, state, dedupKey);
      return;
    }
    this.eapTlsSessions.delete(state);
    const accepted = ctx.session.result === 'accept';
    const eapUser = this.config.users.get(ctx.username);
    if (!accepted) this.publishRejected(dstIp.toString(), ctx.username, 'bad-password');
    this.replyEap(inPort, dstIp, clientPort, request, nextRequest, accepted, eapUser, dedupKey);
  }

  /**
   * MS-CHAPv2 over RADIUS (RFC 2759, RFC 2548 §2.3/2.4): unlike EAP, every
   * crypto value the peer will ever send is already in this one
   * Access-Request (MS-CHAP-Challenge + MS-CHAP2-Response) — a single
   * accept/reject decision, no challenge round-trip of our own.
   */
  private handleMsChapV2Request(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    username: string, user: RadiusUser | undefined, responseVsa: RadiusAttribute, dedupKey: string,
  ): void {
    const challengeVsa = getVsa(request, MICROSOFT_VENDOR_ID, 11);
    const blob = hexToBytes(String(responseVsa.value));
    if (!challengeVsa || blob.length < 50) {
      this.publishRejected(dstIp.toString(), username, 'bad-password');
      this.reply(inPort, dstIp, clientPort, request, false, undefined, dedupKey);
      return;
    }
    if (!user) {
      this.publishRejected(dstIp.toString(), username, 'unknown-user');
      this.reply(inPort, dstIp, clientPort, request, false, undefined, dedupKey);
      return;
    }

    const authChallenge = hexToBytes(String(challengeVsa.value));
    const peerChallenge = blob.subarray(2, 18);
    const ntResponse = blob.subarray(26, 50);

    const expected = generateNtResponse(authChallenge, peerChallenge, username, user.password);
    if (bytesToHex(expected) !== bytesToHex(ntResponse)) {
      this.publishRejected(dstIp.toString(), username, 'bad-password');
      this.reply(inPort, dstIp, clientPort, request, false, undefined, dedupKey);
      return;
    }

    this.replyMsChapV2Success(inPort, dstIp, clientPort, request, username, user, peerChallenge, authChallenge, ntResponse, dedupKey);
  }

  /** Access-Accept carrying MS-CHAP2-Success (mutual-auth proof) and the MPPE session-key VSAs (RFC 3079/2548). */
  private replyMsChapV2Success(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    username: string, user: RadiusUser, peerChallenge: Uint8Array, authChallenge: Uint8Array,
    ntResponse: Uint8Array, dedupKey: string,
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;

    const authenticatorResponse = generateAuthenticatorResponse(user.password, ntResponse, peerChallenge, authChallenge, username);
    const authResponseBytes = utf8ToBytes(authenticatorResponse);
    const successBlob = new Uint8Array(1 + authResponseBytes.length);
    successBlob.set(authResponseBytes, 1); // byte 0 (Ident) left at 0

    const passwordHashHash = md4(ntPasswordHash(user.password));
    const { sendKey, recvKey } = deriveMppeKeys(passwordHashHash, ntResponse);
    // RFC 2548 §2.4.3: encrypted against the Access-Request's own Request
    // Authenticator (not this Access-Accept's Response Authenticator, which
    // isn't known yet) — the same convention `encryptUserPassword` already
    // uses for User-Password.
    const attrs: RadiusAttribute[] = [
      attr('vendor-specific', bytesToHex(successBlob), { id: MICROSOFT_VENDOR_ID, type: 26 }),
      attr('vendor-specific', encryptMppeKey(sendKey, this.config.sharedSecret, request.authenticator, randomSalt()), { id: MICROSOFT_VENDOR_ID, type: 16 }),
      attr('vendor-specific', encryptMppeKey(recvKey, this.config.sharedSecret, request.authenticator, randomSalt()), { id: MICROSOFT_VENDOR_ID, type: 17 }),
    ];
    if (user.replyAttributes) attrs.push(...user.replyAttributes);

    let response: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: request.identifier,
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
        identifier: response.identifier, username: user.username,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.config.port, response);
    Logger.info(this.host.id, 'radius:mschapv2',
      `${this.host.name}: ${dstIp} access-accept (MS-CHAPv2) for ${user.username}`);
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

  private extractRealm(username: string): string | null {
    const m = /^.+@([^@]+)$/.exec(username);
    return m ? m[1] : null;
  }

  /** RFC 2607 — forward this Access-Request to the realm's home server, tracking it under our own identifier space. */
  private forwardToRealm(
    inPort: string, nasIp: IPAddress, nasPort: number, request: RadiusPacket,
    username: string, realm: string, route: RealmRoute, dedupKey: string,
  ): void {
    const egress = this.resolveEgress(route.homeServerIp);
    if (!egress) {
      this.publishRejected(nasIp.toString(), username, 'client-not-authorized');
      this.reply(inPort, nasIp, nasPort, request, false, undefined, dedupKey);
      return;
    }

    let outIdentifier = this.nextProxyIdentifier;
    for (let i = 0; i < 256 && this.pendingProxy.has(outIdentifier); i++) {
      outIdentifier = (outIdentifier + 1) & 0xff;
    }
    this.nextProxyIdentifier = (outIdentifier + 1) & 0xff;
    const outAuthenticator = randomRequestAuthenticator();

    const attrs: RadiusAttribute[] = [attr('user-name', username)];
    const chapAttr = getAttr(request, 'chap-password');
    if (chapAttr) {
      // CHAP-Password doesn't depend on the RADIUS shared secret — safe to forward verbatim across hops.
      attrs.push(attr('chap-password', String(chapAttr.value)));
      const challengeAttr = getAttr(request, 'chap-challenge');
      attrs.push(attr('chap-challenge', challengeAttr ? String(challengeAttr.value) : request.authenticator));
    } else {
      const passwordAttr = getAttr(request, 'user-password');
      if (passwordAttr) {
        // User-Password is encrypted per-hop: decrypt with the NAS-facing secret, re-encrypt with the home server's.
        const decrypted = decryptUserPassword(String(passwordAttr.value), this.config.sharedSecret, request.authenticator);
        attrs.push(attr('user-password', encryptUserPassword(decrypted, route.homeSecret, outAuthenticator)));
      }
    }
    attrs.push(attr('nas-ip-address', egress.srcIp.toString()));

    const outbound: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: outIdentifier,
      authenticator: outAuthenticator, attributes: attrs,
    };

    const timer = this.getScheduler().setTimeout(() => {
      this.pendingProxy.delete(outIdentifier);
    }, route.timeoutMs);

    this.pendingProxy.set(outIdentifier, {
      nasInPort: inPort, nasIp: nasIp.toString(), nasPort,
      originalIdentifier: request.identifier, originalAuthenticator: request.authenticator,
      nasSecret: this.config.sharedSecret,
      homeServerIp: route.homeServerIp, homePort: route.homePort, homeSecret: route.homeSecret,
      outAuthenticator, dedupKey, timer,
    });

    this.getBus().publish({
      topic: 'radius.proxy.forwarded',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        username, realm, homeServerIp: route.homeServerIp,
      },
    });
    Logger.info(this.host.id, 'radius:proxy',
      `${this.host.name}: forwarding ${username} (realm ${realm}) → home server ${route.homeServerIp}`);
    this.sendRadiusFrame(egress.name, egress.port, egress.srcIp, new IPAddress(route.homeServerIp), route.homePort, this.config.port, outbound);
  }

  /** The home server's Access-Accept/Reject for a request we forwarded — translate it back to the original NAS. Returns false when the reply doesn't match any pending proxied request (so the caller can fall through to normal handling). */
  private tryCompleteProxyReply(srcIp: IPAddress, udp: UDPPacket, payload: RadiusPacket): boolean {
    const ctx = this.pendingProxy.get(payload.identifier);
    if (!ctx) return false;
    if (srcIp.toString() !== ctx.homeServerIp || udp.sourcePort !== ctx.homePort) return false;
    if (!verifyResponseAuthenticator(payload, ctx.outAuthenticator, ctx.homeSecret)) return false;

    this.pendingProxy.delete(payload.identifier);
    if (ctx.timer !== null) this.getScheduler().clear(ctx.timer);

    const port = this.host.getPort(ctx.nasInPort);
    if (!port) return true;
    const nasSrcIp = port.getIPAddress();
    if (!nasSrcIp) return true;

    const forwardedAttrs = payload.attributes.filter(
      (a) => a.type !== 'message-authenticator' && a.type !== 'state',
    );
    let response: RadiusPacket = {
      type: 'radius', code: payload.code, identifier: ctx.originalIdentifier,
      authenticator: '00'.repeat(16), attributes: forwardedAttrs,
    };
    response = withMessageAuthenticator(response, ctx.originalAuthenticator, ctx.nasSecret);
    response = withResponseAuthenticator(response, ctx.originalAuthenticator, ctx.nasSecret);
    this.recentReplies.set(ctx.dedupKey, { response, sentAt: Date.now() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: ctx.nasIp, code: response.code,
        identifier: response.identifier, username: null,
      },
    });
    this.sendRadiusFrame(ctx.nasInPort, port, nasSrcIp, new IPAddress(ctx.nasIp), ctx.nasPort, this.config.port, response);
    Logger.info(this.host.id, 'radius:proxy',
      `${this.host.name}: proxied ${response.code} from ${ctx.homeServerIp} → NAS ${ctx.nasIp}`);
    return true;
  }

  /** Egress toward an arbitrary target IP (the home server, typically off-subnet) — mirrors `RadiusClientAgent`'s own resolver. */
  private resolveEgress(targetIp: string): { name: string; port: Port; srcIp: IPAddress } | null {
    if (this.host.resolveRoute) {
      const route = this.host.resolveRoute(targetIp);
      if (route) {
        const port = this.host.getPort(route.iface);
        const src = port?.getIPAddress();
        if (port && src && port.getIsUp()) return { name: route.iface, port, srcIp: src };
      }
    }
    const target = targetIp.split('.').map(Number);
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      const mask = port.getSubnetMask();
      if (!ip || !mask || !port.getIsUp()) continue;
      const local = ip.toString().split('.').map(Number);
      const maskBits = mask.toString().split('.').map(Number);
      let same = true;
      for (let i = 0; i < 4; i++) {
        if ((local[i] & maskBits[i]) !== (target[i] & maskBits[i])) { same = false; break; }
      }
      if (same) return { name: port.getName(), port, srcIp: ip };
    }
    for (const port of this.host.getPorts()) {
      const ip = port.getIPAddress();
      if (ip && port.getIsUp() && port.isConnected()) return { name: port.getName(), port, srcIp: ip };
    }
    return null;
  }

  private sendRadiusFrame(
    inPort: string, port: Port, srcIp: IPAddress, dstIp: IPAddress,
    clientPort: number, sourcePort: number, response: RadiusPacket,
  ): void {
    const ipPkt = buildUdpOverIpv4(srcIp, {
      destination: dstIp,
      destinationPort: clientPort, sourcePort,
      payload: response, payloadBytes: 20 + 16 - 8,
    });
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: this.host.resolveMac?.(dstIp.toString()) ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(inPort, eth);
  }
}

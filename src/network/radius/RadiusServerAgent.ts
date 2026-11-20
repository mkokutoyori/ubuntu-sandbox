import { RadiusClientTable } from './ClientTable';
import { simulationNowMs } from '@/network/core/SystemClock';

import type { IEventBus } from '@/events/EventBus';
import type { RadiusAuthDecidedPayload } from './events';
import { encodeRadiusPacket } from './codec';
import type { UdpSendRequest } from '../layers/transport/UdpEgress';
import { hexToBytes, bytesToHex, utf8ToBytes } from '@/crypto/encoding';
import { md4 } from '@/crypto/hash';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type RadiusServerAgentConfig, type RadiusPacket, type RadiusUser,
  type RadiusAttribute, type ProxyRoute, type StatusCheck,
  createDefaultServerConfig, attr, getAttr, getVsa, RADIUS_PACKET_NAME,
  decryptUserPassword, encryptUserPassword, isPrintablePassword,
} from './types';
import {
  verifyMessageAuthenticator, withMessageAuthenticator, withResponseAuthenticator,
  randomOpaqueToken, randomRequestAuthenticator, verifyResponseAuthenticator,
  verifyAccountingRequestAuthenticator, withAccountingRequestAuthenticator,
} from './authenticators';
import { parseChapPasswordHex, verifyChapResponse } from './passwords';
import { loginTimeSecondsLeft } from './LoginTime';
import { formatRadiusAttribute } from './attributeText';
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
  IPAddress,
  type EthernetFrame, type UDPPacket,
  type IPv4Packet,
} from '../core/types';
import type { Port } from '../hardware/Port';
import { Logger } from '../core/Logger';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';

/** RFC 2548 §2.4.1 — Salt only needs to be unique-ish per attribute; `encryptMppeKey` forces its top bit to 1. */
function randomSalt(): number {
  return Math.floor(Math.random() * 0x10000);
}

const UTMP_PORT_TYPES = ['A', 'S', 'I', 'T', 'X'];

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
  utmp?: UtmpFields;
}

export interface UtmpFields {
  nasPort: number;
  protocol: 'P' | 'S' | 'T';
  portType: string;
  framedAddress: string | null;
  callerId: string;
  startedAtMs: number;
}

export interface RadiusServerHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-resolved next-hop MAC, when known — falls back to broadcast otherwise (mirrors `TcpHost`). */
  sendIpv4FrameArpAware(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  sourceAddressFor(destination: IPAddress): IPAddress | null;
  /** Real RIB lookup (LPM) — needed to reach a proxy realm's home server on another subnet (mirrors `RadiusClientHost`). */
}

/** How long a served response is kept for retransmission dedup (RFC 2865 §2). */
const DEDUP_TTL_MS = 30_000;
/** How long an issued Access-Challenge's State stays redeemable (RFC 2865 §4.4). */
const CHALLENGE_TTL_MS = 60_000;

type RejectReason = 'unknown-user' | 'bad-password' | 'bad-secret' | 'client-not-authorized' | 'outside-login-time' | 'simultaneous-use';

const LOGIN_TIME_MINIMUM_TIMEOUT_SECONDS = 60;

/** RFC 2607 — a realm this server proxies to a home server instead of authenticating locally. */
interface RealmRoute {
  homeServerIp: string;
  homePort: number;
  homeSecret: string;
  timeoutMs: number;
  statusCheck?: StatusCheck;
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
  kind: 'auth' | 'acct';
}

/** Extra context a `setUserResolver` callback may need beyond the username itself. */
export interface RadiusPacketTrace {
  number: number;
  direction: 'received' | 'sent';
  packet: RadiusPacket;
  sourceIp: string;
  sourcePort: number;
  destinationIp: string;
  destinationPort: number;
  length: number;
}

export interface RequestDebugInfo {
  port: number;
  request: RadiusPacket;
  username: string;
  user: RadiusUser | undefined;
  accepted: boolean;
  receivedLines: string[];
  replyLines: string[];
  postAuthLines: string[];
}

export interface AccountingRun {
  packet: RadiusPacket;
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  atMs: number;
  recordUtmp: (attributes: readonly RadiusAttribute[]) => void;
}

export type RequestFeature = 'pap' | 'chap' | 'mschap' | 'eap' | 'session' | 'accounting-utmp';

export interface RadiusUserResolverContext {
  listenPort?: number;
  packet?: { sourceIp: string; sourcePort: number; destinationIp: string; destinationPort: number; type: string; authenticator: string };
  /** The requesting NAS's source IP, as seen on this Access-Request. */
  nasIp: string;
  attributes: RadiusAttribute[];
}

function srcIpOfPort(port: { getIPAddress(): { toString(): string } | null } | undefined): string {
  return port?.getIPAddress()?.toString() ?? '0.0.0.0';
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
  private readonly probeLoops = new Map<string, { timer: TimerHandle | null; answers: number; route: RealmRoute; accounting: boolean }>();
  private readonly pendingProbes = new Map<number, { key: string; authenticator: string; secret: string; address: string; port: number; timer: TimerHandle | null }>();
  private readonly homeActivity = new Map<string, { lastReplyMs: number | null; timedOutAtMs: number | null; adminDown?: boolean }>();
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
    for (const loop of this.probeLoops.values()) if (loop.timer !== null) this.getScheduler().clear(loop.timer);
    this.probeLoops.clear();
    for (const probe of this.pendingProbes.values()) if (probe.timer !== null) this.getScheduler().clear(probe.timer);
    this.pendingProbes.clear();
  }

  getConfig(): Readonly<RadiusServerAgentConfig> { return this.config; }

  setEnabled(on: boolean): void { this.config.enabled = on; }

  setRejectReplyMessage(message: string | null): void { this.config.rejectReplyMessage = message; }

  setStatusServer(on: boolean): void { this.config.statusServer = on; }

  setDeniedMessage(message: string): void { this.config.deniedMessage = message; }

  private featurePolicy: (feature: RequestFeature, listenPort: number) => boolean = () => true;

  setFeaturePolicy(policy: (feature: RequestFeature, listenPort: number) => boolean): void { this.featurePolicy = policy; }

  private allows(feature: RequestFeature): boolean {
    return this.featurePolicy(feature, this.servedPort ?? this.config.port);
  }

  private simultaneousUseDenial(user: RadiusUser | undefined, username: string): { reply: RadiusAttribute[]; note: string } | null {
    if (user?.simultaneousUse === undefined || !this.allows('session')) return null;
    const maximum = user.simultaneousUse;
    const active = this.utmpSessions().filter((record) => record.username === username);
    if (active.length < maximum) return null;
    for (const record of active) {
      const nasType = this.clientTable.find(new IPAddress(record.nasIp))?.nasType ?? 'other';
      if (nasType !== 'other' && nasType !== '') return null;
    }
    const denied = this.config.deniedMessage ?? 'You are already logged in - access denied';
    return { reply: [attr('reply-message', maximum > 1 ? `${denied} (${maximum})` : denied)], note: `Multiple logins (max ${maximum}) ` };
  }

  private wallClockMs: () => number = () => simulationNowMs();
  private minuteOfWeek: (epochMs: number) => number = (epochMs) => {
    const date = new Date(epochMs);
    return date.getUTCDay() * 1440 + date.getUTCHours() * 60 + date.getUTCMinutes();
  };

  setWallClock(nowMs: () => number, minuteOfWeek: (epochMs: number) => number): void {
    this.wallClockMs = nowMs;
    this.minuteOfWeek = minuteOfWeek;
  }

  private loginTimeVerdict(user: RadiusUser | undefined): { allowed: boolean; secondsLeft: number } {
    if (user?.loginTime === undefined) return { allowed: true, secondsLeft: 0 };
    const left = loginTimeSecondsLeft(user.loginTime, this.minuteOfWeek(this.wallClockMs()));
    if (left < 0) return { allowed: false, secondsLeft: 0 };
    if (left > 0 && left < LOGIN_TIME_MINIMUM_TIMEOUT_SECONDS) return { allowed: false, secondsLeft: 0 };
    return { allowed: true, secondsLeft: left };
  }

  private anyPort = false;
  private servedPort: number | null = null;

  setAnyPort(on: boolean): void { this.anyPort = on; }

  private authSource(): number { return this.servedPort ?? this.config.port; }
  private acctSource(): number { return this.servedPort ?? this.config.acctPort; }

  private unknownClientListener: ((event: { kind: 'auth' | 'acct'; port: number; clientIp: string; clientPort: number }) => void) | null = null;
  private lastUnknownClientSecond = -1;

  setUnknownClientListener(listener: ((event: { kind: 'auth' | 'acct'; port: number; clientIp: string; clientPort: number }) => void) | null): void {
    this.unknownClientListener = listener;
  }

  private reportUnknownClient(kind: 'auth' | 'acct', senderIp: string, clientPort: number, listenPort: number): void {
    if (this.unknownClientListener === null) return;
    if (this.packetTrace === null) {
      const second = Math.floor(simulationNowMs() / 1000);
      if (second === this.lastUnknownClientSecond) return;
      this.lastUnknownClientSecond = second;
    }
    this.unknownClientListener({ kind, port: listenPort, clientIp: senderIp, clientPort });
  }

  private warningListener: ((message: string) => void) | null = null;

  setWarningListener(listener: ((message: string) => void) | null): void { this.warningListener = listener; }

  setPorts(authPort: number, acctPort: number): void {
    this.config.port = authPort;
    this.config.acctPort = acctPort;
  }

  setSharedSecret(secret: string): void {
    this.config.sharedSecret = secret;
    this.clientTable.clear();
  }

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

  requireAuthorizedClient(on: boolean): void { this.config.requireAuthorizedClient = on; }

  readonly clientTable = new RadiusClientTable();

  private accountingListener: ((record: { sourceIp: string; destinationIp: string; sourcePort: number; destinationPort: number; packet: RadiusPacket; atMs: number }) => void) | null = null;

  setAccountingListener(listener: ((record: { sourceIp: string; destinationIp: string; sourcePort: number; destinationPort: number; packet: RadiusPacket; atMs: number }) => void) | null): void {
    this.accountingListener = listener;
  }

  private requestNumber = -1;

  private packetTrace: ((event: RadiusPacketTrace) => void) | null = null;
  private traceOpen = false;

  setPacketTrace(listener: ((event: RadiusPacketTrace) => void) | null): void {
    this.packetTrace = listener;
    this.traceOpen = false;
  }

  private displayAttributes(packet: RadiusPacket, srcIp: IPAddress, decrypt: boolean): RadiusAttribute[] {
    return decrypt
      ? packet.attributes.map((attribute) => {
        if (attribute.type !== 'user-password') return attribute;
        const clear = decryptUserPassword(String(attribute.value), this.secretFor(srcIp), packet.authenticator);
        return isPrintablePassword(clear) ? { ...attribute, value: clear } : attribute;
      })
      : packet.attributes;
  }

  private accountingRunner: ((run: AccountingRun) => boolean | ProxyRoute) | null = null;

  setAccountingRunner(runner: ((run: AccountingRun) => boolean | ProxyRoute) | null): void { this.accountingRunner = runner; }

  private postAuthHook: ((info: { port: number; accepted: boolean; userReply: readonly RadiusAttribute[] }) => { reply: RadiusAttribute[]; lines: string[] } | null) | null = null;

  setPostAuthHook(hook: ((info: { port: number; accepted: boolean; userReply: readonly RadiusAttribute[] }) => { reply: RadiusAttribute[]; lines: string[] } | null) | null): void { this.postAuthHook = hook; }

  private debugEmit: ((number: number, lines: string[]) => void) | null = null;
  private debugBuilder: ((info: RequestDebugInfo) => string[]) | null = null;

  setDebugEmit(emit: ((number: number, lines: string[]) => void) | null): void { this.debugEmit = emit; }

  emitDebugLines(lines: string[]): void { this.debugEmit?.(this.requestNumber, lines); }

  setDebugBuilder(builder: ((info: RequestDebugInfo) => string[]) | null): void { this.debugBuilder = builder; }

  loginTimeOutcome(user: RadiusUser | undefined): { result: 'noop' | 'ok' | 'updated' | 'userlock'; secondsLeft: number } {
    if (user?.loginTime === undefined) return { result: 'noop', secondsLeft: 0 };
    const verdict = this.loginTimeVerdict(user);
    if (!verdict.allowed) return { result: 'userlock', secondsLeft: 0 };
    return { result: verdict.secondsLeft > 0 ? 'updated' : 'ok', secondsLeft: verdict.secondsLeft };
  }

  private emitRequestDebug(request: RadiusPacket, srcIp: IPAddress, username: string, user: RadiusUser | undefined, accepted: boolean, postAuthLines: string[], finalReply: readonly RadiusAttribute[]): void {
    if (this.debugEmit === null || this.debugBuilder === null) return;
    const lineOf = (attribute: RadiusAttribute) => `  ${formatRadiusAttribute(attribute)}`;
    this.debugEmit(this.requestNumber, this.debugBuilder({
      port: this.servedPort ?? this.config.port, request, username, user, accepted,
      receivedLines: this.displayAttributes(request, srcIp, true).map(lineOf),
      replyLines: finalReply.map(lineOf), postAuthLines,
    }));
  }

  private traceReceived(packet: RadiusPacket, srcIp: IPAddress, srcPort: number, dstPort: number, inPort: string, decrypt: boolean): void {
    if (this.packetTrace === null) return;
    const attributes = this.displayAttributes(packet, srcIp, decrypt);
    this.traceOpen = true;
    this.packetTrace({
      number: this.requestNumber, direction: 'received', packet: { ...packet, attributes },
      sourceIp: srcIp.toString(), sourcePort: srcPort, destinationIp: srcIpOfPort(this.host.getPort(inPort)), destinationPort: dstPort,
      length: encodeRadiusPacket(packet).length,
    });
  }

  private traceSent(packet: RadiusPacket, srcIp: IPAddress, srcPort: number, dstIp: IPAddress, dstPort: number): void {
    if (this.packetTrace === null || !this.traceOpen) return;
    this.traceOpen = false;
    this.packetTrace({
      number: this.requestNumber, direction: 'sent', packet,
      sourceIp: srcIp.toString(), sourcePort: srcPort, destinationIp: dstIp.toString(), destinationPort: dstPort,
      length: encodeRadiusPacket(packet).length,
    });
  }

  private decisionListener: ((payload: RadiusAuthDecidedPayload) => void) | null = null;

  setDecisionListener(listener: ((payload: RadiusAuthDecidedPayload) => void) | null): void { this.decisionListener = listener; }

  private publishDecision(request: RadiusPacket, clientIp: IPAddress, accepted: boolean, precedingMessage?: string): void {
    const passwordAttr = getAttr(request, 'user-password');
    const chapAttr = getAttr(request, 'chap-password');
    let password = '<no User-Password attribute>';
    if (chapAttr) password = '<CHAP-Password>';
    else if (passwordAttr) password = decryptUserPassword(String(passwordAttr.value), this.secretFor(clientIp), request.authenticator);
    const payload: RadiusAuthDecidedPayload = {
      deviceId: this.host.id, hostname: this.host.getHostname(),
      number: this.requestNumber, accepted, clientIp: clientIp.toString(),
      clientShortname: this.clientTable.find(clientIp)?.shortname ?? clientIp.toString(),
      username: getAttr(request, 'user-name')?.value ?? null,
      password, nasPort: Number(getAttr(request, 'nas-port')?.value ?? 0),
      callingStationId: getAttr(request, 'calling-station-id')?.value ?? null,
      ...(precedingMessage === undefined ? {} : { precedingMessage }),
    };
    this.getBus().publish({ topic: 'radius.auth.decided', payload });
    this.decisionListener?.(payload);
  }

  private clientRefused(senderIp: string): boolean {
    if (this.clientTable.size > 0 && this.clientTable.find(new IPAddress(senderIp)) !== null) return false;
    const restricted = this.config.requireAuthorizedClient === true || this.config.clients.size > 0 || this.clientTable.size > 0;
    return restricted && !this.config.clients.has(senderIp);
  }

  private secretFor(ip: IPAddress | string): string {
    if (this.clientTable.size === 0) return this.config.sharedSecret;
    const entry = this.clientTable.find(typeof ip === 'string' ? new IPAddress(ip) : ip);
    return entry === null ? this.config.sharedSecret : entry.secret;
  }

  authorizeClient(clientIp: string): void { this.config.clients.add(clientIp); }
  revokeClient(clientIp: string): void { this.config.clients.delete(clientIp); }

  listUsers(): RadiusUser[] { return Array.from(this.config.users.values()); }

  utmpSessions(): AcctSessionRecord[] {
    return Array.from(this.acctSessions.values()).filter((record) => record.status !== 'stop' && record.utmp !== undefined);
  }

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

  setHomeServerState(address: string, port: number, timing: { pingIntervalMs: number; zombiePeriodMs: number }, state: 'alive' | 'dead' | 'down'): void {
    const now = simulationNowMs();
    const key = `${address}:${port}`;
    if (state === 'alive') this.homeActivity.set(key, { lastReplyMs: now, timedOutAtMs: null });
    else if (state === 'dead') this.homeActivity.set(key, { lastReplyMs: null, timedOutAtMs: now - timing.zombiePeriodMs });
    else this.homeActivity.set(key, { lastReplyMs: null, timedOutAtMs: null, adminDown: true });
  }

  homeServerState(address: string, port: number, timing: { pingIntervalMs: number; zombiePeriodMs: number; reviveIntervalMs: number }): { state: 'alive' | 'zombie' | 'dead' | 'down' | 'unknown'; outstanding: number } {
    const outstanding = Array.from(this.pendingProxy.values()).filter((ctx) => ctx.homeServerIp === address && ctx.homePort === port).length;
    const activity = this.homeActivity.get(`${address}:${port}`);
    const now = simulationNowMs();
    if (activity?.adminDown === true) return { state: 'down', outstanding };
    if (activity?.timedOutAtMs !== null && activity?.timedOutAtMs !== undefined) {
      const silent = now - activity.timedOutAtMs;
      if (silent < timing.zombiePeriodMs) return { state: 'zombie', outstanding };
      if (silent < timing.zombiePeriodMs + timing.reviveIntervalMs) return { state: 'dead', outstanding };
      return { state: 'unknown', outstanding };
    }
    if (activity?.lastReplyMs !== null && activity?.lastReplyMs !== undefined && now - activity.lastReplyMs <= timing.pingIntervalMs) return { state: 'alive', outstanding };
    return { state: 'unknown', outstanding };
  }
  listRealms(): Array<{ realm: string } & RealmRoute> {
    return Array.from(this.realms.entries()).map(([realm, route]) => ({ realm, ...route }));
  }

  /** External user store lookup (e.g. Windows NPS resolving against the SAM/AD directory), tried when `username` isn't in the static `addUser` table — RFC 2865 doesn't mandate a static user list; this keeps that model without hosts needing to mirror a live directory into it. The optional `context` (currently just the requesting NAS's IP) lets a resolver evaluate conditions that need to know who's asking — e.g. NPS Connection Request Policies (PRD-Windows-Server-Advanced.md §5 P22) keyed on NAS identity. */
  private userResolver: ((username: string, context?: RadiusUserResolverContext) => RadiusUser | undefined) | null = null;
  setUserResolver(fn: ((username: string, context?: RadiusUserResolverContext) => RadiusUser | undefined) | null): void { this.userResolver = fn; }

  /** RFC 2866: Accounting-Request/Response on the accounting port (default UDP/1813). */
  handleStreamRequest(
    srcIp: IPAddress, srcPort: number, localIp: IPAddress, localPort: number,
    request: RadiusPacket, reply: (response: RadiusPacket) => void,
  ): void {
    const inPort = this.host.getPorts().find((candidate) => candidate.getIPAddress()?.toString() === localIp.toString());
    if (!inPort) return;
    const udp = { type: 'udp', sourcePort: srcPort, destinationPort: localPort, length: 0, checksum: 0, payload: request } as UDPPacket;
    const previousSink = this.streamSink;
    const previousPort = this.servedPort;
    this.streamSink = reply;
    this.servedPort = localPort;
    try {
      if (request.code === 'accounting-request') this.handleAcctUdp(inPort.getName(), srcIp, udp, true);
      else this.handleUdp(inPort.getName(), srcIp, udp, true);
    } finally {
      this.streamSink = previousSink;
      this.servedPort = previousPort;
    }
  }

  private streamSink: ((response: RadiusPacket) => void) | null = null;

  handleAcctUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket, viaStream = false): void {
    if (!this.running || !this.config.enabled) return;
    if (!viaStream && !this.anyPort && udp.destinationPort !== this.config.acctPort) return;
    if (this.anyPort) this.servedPort = udp.destinationPort;
    const payload = udp.payload as RadiusPacket | undefined;
    if (payload?.type === 'radius' && payload.code === 'status-server') {
      this.handleStatusServer(inPort, srcIp, udp, payload, 'accounting-response', this.recentAcctReplies);
      return;
    }
    if (payload?.type === 'radius' && payload.code === 'accounting-response' && (this.pendingProxy.size > 0 || this.pendingProbes.size > 0) && this.tryCompleteProxyReply(srcIp, udp, payload)) return;
    if (!payload || payload.type !== 'radius' || payload.code !== 'accounting-request') return;

    const senderIp = srcIp.toString();
    if (this.clientRefused(senderIp)) {
      this.reportUnknownClient('acct', senderIp, udp.sourcePort, udp.destinationPort);
      return;
    }
    if (!verifyAccountingRequestAuthenticator(payload, this.secretFor(srcIp))) {
      Logger.warn(this.host.id, 'radius:bad-accounting-authenticator',
        `${this.host.name}: dropped Accounting-Request from ${srcIp} — invalid Authenticator (shared secret mismatch?)`);
      return;
    }
    const dedupKey = `acct:${senderIp}:${udp.sourcePort}:${payload.identifier}:${payload.authenticator}`;
    this.pruneAcctDedupCache();
    const cached = this.recentAcctReplies.get(dedupKey);
    if (cached) {
      this.resendAcct(inPort, srcIp, udp.sourcePort, cached.response);
      return;
    }

    this.requestNumber++;
    this.traceReceived(payload, srcIp, udp.sourcePort, udp.destinationPort, inPort, false);
    const sessionIdAttr = getAttr(payload, 'acct-session-id');
    const usernameAttr = getAttr(payload, 'user-name');
    const statusAttr = getAttr(payload, 'acct-status-type');
    const nasRebootStatus = statusAttr === undefined ? undefined : ACCT_STATUS_BY_NUMBER.get(Number(statusAttr.value));
    if (nasRebootStatus === 'accounting-on' || nasRebootStatus === 'accounting-off') {
      const rebootedNas = String(getAttr(payload, 'nas-ip-address')?.value ?? senderIp);
      const at = simulationNowMs();
      for (const record of this.acctSessions.values()) {
        if (record.nasIp === rebootedNas && record.status !== 'stop') {
          Object.assign(record, { status: 'stop', updatedAt: at, terminateCause: 'nas-reboot' });
        }
      }
      this.accountingListener?.({
        sourceIp: senderIp, destinationIp: srcIpOfPort(this.host.getPort(inPort)), sourcePort: udp.sourcePort, destinationPort: udp.destinationPort,
        packet: payload, atMs: at,
      });
      this.replyAcct(inPort, srcIp, udp.sourcePort, payload, dedupKey);
      return;
    }
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

    const now = simulationNowMs();
    const wallNow = this.wallClockMs();
    const sessionKey = `${nasIp}|${sessionId}`;
    const existing = this.acctSessions.get(sessionKey);
    const nasPortAttribute = getAttr(payload, 'nas-port');
    const framedProtocol = Number(getAttr(payload, 'framed-protocol')?.value);
    this.acctSessions.set(sessionKey, {
      sessionId, username, nasIp, status,
      startedAt: status === 'start' ? now : (existing?.startedAt ?? now),
      updatedAt: now, sessionTimeSec, inputOctets, outputOctets, terminateCause,
      ...(existing?.utmp === undefined ? {} : { utmp: existing.utmp }),
    });
    const recordUtmp = (attributes: readonly RadiusAttribute[]): void => {
      const record = this.acctSessions.get(sessionKey);
      if (record === undefined || record.utmp !== undefined || status === 'stop' || username === '!root') return;
      const nasPortOf = attributes.find((attribute) => attribute.type === 'nas-port');
      if (nasPortOf === undefined) return;
      const protocolOf = Number(attributes.find((attribute) => attribute.type === 'framed-protocol')?.value);
      record.utmp = {
        nasPort: Number(nasPortOf.value),
        protocol: protocolOf === 1 ? 'P' : protocolOf === 2 ? 'S' : 'T',
        portType: UTMP_PORT_TYPES[Number(attributes.find((attribute) => attribute.type === 'nas-port-type')?.value)] ?? 'A',
        framedAddress: String(attributes.find((attribute) => attribute.type === 'framed-ip-address')?.value ?? attributes.find((attribute) => attribute.type === 'login-ip-host')?.value ?? '') || null,
        callerId: this.config.callerIdInUtmp === false ? '' : String(attributes.find((attribute) => attribute.type === 'calling-station-id')?.value ?? '').slice(0, 15),
        startedAtMs: wallNow - Number(attributes.find((attribute) => attribute.type === 'acct-delay-time')?.value ?? 0) * 1000,
      };
    };

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

    if (this.accountingRunner !== null) {
      const answered = this.accountingRunner({
        packet: payload, sourceIp: senderIp, destinationIp: srcIpOfPort(this.host.getPort(inPort)), sourcePort: udp.sourcePort,
        destinationPort: udp.destinationPort, atMs: now, recordUtmp,
      });
      if (typeof answered === 'object') {
        const { realm: proxiedRealm, forwardName, fallbacks, ...route } = answered;
        this.forwardToRealm(inPort, srcIp, udp.sourcePort, payload, forwardName, proxiedRealm, route, dedupKey, fallbacks, 'acct');
        return;
      }
      if (!answered) return;
    } else {
      if (this.allows('accounting-utmp')) recordUtmp(payload.attributes);
      this.accountingListener?.({
        sourceIp: senderIp, destinationIp: srcIpOfPort(this.host.getPort(inPort)), sourcePort: udp.sourcePort, destinationPort: udp.destinationPort,
        packet: payload, atMs: now,
      });
    }
    this.replyAcct(inPort, srcIp, udp.sourcePort, payload, dedupKey);
  }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket, viaStream = false): void {
    if (!this.running || !this.config.enabled) return;
    if (!viaStream && !this.anyPort && udp.destinationPort !== this.config.port) return;
    if (this.anyPort) this.servedPort = udp.destinationPort;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;

    if ((payload.code === 'access-accept' || payload.code === 'access-reject') && (this.pendingProxy.size > 0 || this.pendingProbes.size > 0)) {
      if (this.tryCompleteProxyReply(srcIp, udp, payload)) return;
    }
    if (payload.code === 'status-server') {
      this.handleStatusServer(inPort, srcIp, udp, payload, 'access-accept', this.recentReplies);
      return;
    }
    if (payload.code !== 'access-request') return;

    const eapAttr = getAttr(payload, 'eap-message');
    if (eapAttr && !getAttr(payload, 'message-authenticator')) {
      Logger.warn(this.host.id, 'radius:missing-message-authenticator',
        `${this.host.name}: dropped Access-Request from ${srcIp} — EAP-Message without Message-Authenticator (RFC 3579 §3.2)`);
      return;
    }
    if (!verifyMessageAuthenticator(payload, payload.authenticator, this.secretFor(srcIp))) {
      Logger.warn(this.host.id, 'radius:bad-message-authenticator',
        `${this.host.name}: dropped Access-Request from ${srcIp} — invalid Message-Authenticator`);
      return; // RFC 3579 §3.2 — silently discarded, no reply, no event
    }

    const senderIp = srcIp.toString();
    if (this.clientTable.find(srcIp)?.requireMessageAuthenticator === 'yes' && !getAttr(payload, 'message-authenticator')) {
      Logger.warn(this.host.id, 'radius:insecure-packet',
        `${this.host.name}: Insecure packet from host ${senderIp}:  Packet does not contain required Message-Authenticator attribute.  You may need to set 'require_message_authenticator = no' in the configuration`);
      return;
    }
    const dedupKey = `${senderIp}:${udp.sourcePort}:${payload.identifier}:${payload.authenticator}`;
    this.pruneDedupCache();
    const cached = this.recentReplies.get(dedupKey);
    if (cached) {
      this.resend(inPort, srcIp, udp.sourcePort, cached.response);
      return;
    }

    this.requestNumber++;
    this.traceReceived(payload, srcIp, udp.sourcePort, udp.destinationPort, inPort, true);
    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: senderIp, code: payload.code, identifier: payload.identifier,
      },
    });

    if (this.clientRefused(senderIp)) {
      this.reportUnknownClient('auth', senderIp, udp.sourcePort, udp.destinationPort);
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

    const resolved = this.config.users.get(username) ?? this.userResolver?.(username, { nasIp: senderIp, attributes: payload.attributes, listenPort: this.servedPort ?? this.config.port, packet: { sourceIp: senderIp, sourcePort: udp.sourcePort, destinationIp: srcIpOfPort(this.host.getPort(inPort)), destinationPort: udp.destinationPort, type: RADIUS_PACKET_NAME[payload.code], authenticator: payload.authenticator } });
    if (resolved?.proxy !== undefined) {
      const { realm: proxiedRealm, forwardName, fallbacks, ...route } = resolved.proxy;
      this.forwardToRealm(inPort, srcIp, udp.sourcePort, payload, forwardName, proxiedRealm, route, dedupKey, fallbacks);
      return;
    }
    const loginTime = this.loginTimeVerdict(resolved);
    if (!loginTime.allowed) {
      this.publishRejected(senderIp, username, 'outside-login-time');
      this.reply(inPort, srcIp, udp.sourcePort, payload, false, resolved, dedupKey);
      return;
    }
    const user = loginTime.secondsLeft === 0 || resolved === undefined ? resolved : this.withSessionTimeout(resolved, loginTime.secondsLeft);

    if (eapAttr && !this.allows('eap')) {
      this.publishRejected(senderIp, username, 'bad-password');
      this.reply(inPort, srcIp, udp.sourcePort, payload, false, user, dedupKey);
      return;
    }
    if (eapAttr) {
      this.handleEapRequest(inPort, srcIp, udp.sourcePort, payload, username, user, dedupKey);
      return;
    }

    const msChap2ResponseVsa = getVsa(payload, MICROSOFT_VENDOR_ID, 25);
    if (msChap2ResponseVsa && !this.allows('mschap')) {
      this.publishRejected(senderIp, username, 'bad-password');
      this.reply(inPort, srcIp, udp.sourcePort, payload, false, user, dedupKey);
      return;
    }
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
      accepted = !!user && (user.acceptAny === true || (this.allows('chap') && !!parsed && user.password !== '' && verifyChapResponse(parsed.chapIdentifier, parsed.response, user.password, challenge)));
      reason = !user ? 'unknown-user' : 'bad-password';
    } else {
      const decrypted = decryptUserPassword(String(passwordAttr!.value), this.secretFor(srcIp), payload.authenticator);
      const secretLooksWrong = !isPrintablePassword(decrypted);
      accepted = !secretLooksWrong && !!user && (user.acceptAny === true || (this.allows('pap') && (user.verify ? user.verify(decrypted) : user.password === decrypted)));
      reason = secretLooksWrong ? 'bad-secret' : !user ? 'unknown-user' : 'bad-password';
    }

    const denial = accepted ? this.simultaneousUseDenial(user, username) : null;
    const finalAccepted = accepted && denial === null;
    const post = this.postAuthHook?.({ port: this.servedPort ?? this.config.port, accepted: finalAccepted, userReply: user?.replyAttributes ?? [] }) ?? null;
    const finalUser = finalAccepted && post !== null && user !== undefined ? { ...user, replyAttributes: post.reply } : user;
    const rejectExtra = !finalAccepted && post !== null ? post.reply : [];
    this.emitRequestDebug(payload, srcIp, username, user, accepted, post?.lines ?? [], finalAccepted ? (finalUser?.replyAttributes ?? []) : rejectExtra);
    if (denial !== null) {
      this.publishRejected(senderIp, username, 'simultaneous-use');
      this.reply(inPort, srcIp, udp.sourcePort, payload, false, user, dedupKey, denial, rejectExtra);
      return;
    }
    if (!accepted) this.publishRejected(senderIp, username, reason);
    this.reply(inPort, srcIp, udp.sourcePort, payload, accepted, finalUser, dedupKey, null, rejectExtra);
  }

  handleStatusUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket, clients: RadiusClientTable): void {
    if (!this.running || !this.config.enabled) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius' || payload.code !== 'status-server') return;
    this.handleStatusServer(inPort, srcIp, udp, payload, 'access-accept', this.recentReplies, clients);
  }

  private handleStatusServer(
    inPort: string, srcIp: IPAddress, udp: UDPPacket, request: RadiusPacket,
    replyCode: 'access-accept' | 'accounting-response',
    cache: Map<string, { response: RadiusPacket; sentAt: number }>,
    clients: RadiusClientTable | null = null,
  ): void {
    const senderIp = srcIp.toString();
    const refused = clients === null ? this.clientRefused(senderIp) : clients.find(srcIp) === null;
    if (refused) {
      this.reportUnknownClient(replyCode === 'access-accept' ? 'auth' : 'acct', senderIp, udp.sourcePort, udp.destinationPort);
      return;
    }
    if (this.config.statusServer !== true) {
      const message = 'Ignoring Status-Server request due to security configuration';
      Logger.warn(this.host.id, 'radius:status-server-ignored', `${this.host.name}: ${message}`);
      this.warningListener?.(message);
      return;
    }
    if (!getAttr(request, 'message-authenticator')) {
      Logger.warn(this.host.id, 'radius:insecure-packet',
        `${this.host.name}: Insecure packet from host ${senderIp}:  Packet does not contain required Message-Authenticator attribute.  You may need to set 'require_message_authenticator = no' in the configuration`);
      return;
    }
    const secret = clients === null ? this.secretFor(srcIp) : clients.find(srcIp)!.secret;
    if (!verifyMessageAuthenticator(request, request.authenticator, secret)) {
      Logger.warn(this.host.id, 'radius:bad-message-authenticator',
        `${this.host.name}: Received packet from ${senderIp} with invalid Message-Authenticator!  (Shared secret is incorrect.)`);
      return;
    }
    const port = this.host.getPort(inPort);
    const localIp = port?.getIPAddress();
    if (!port || !localIp) return;
    const dedupKey = `status:${senderIp}:${udp.sourcePort}:${udp.destinationPort}:${request.identifier}:${request.authenticator}`;
    this.pruneDedupCache();
    this.pruneAcctDedupCache();
    const cached = cache.get(dedupKey);
    if (!cached) {
      this.requestNumber++;
      this.traceReceived(request, srcIp, udp.sourcePort, udp.destinationPort, inPort, false);
    }
    let response: RadiusPacket = cached?.response ?? {
      type: 'radius', code: replyCode, identifier: request.identifier, authenticator: '00'.repeat(16), attributes: [],
    };
    if (!cached) {
      response = withMessageAuthenticator(response, request.authenticator, secret);
      response = withResponseAuthenticator(response, request.authenticator, secret);
      cache.set(dedupKey, { response, sentAt: simulationNowMs() });
    }
    this.sendRadiusFrame(inPort, port, localIp, srcIp, udp.sourcePort, udp.destinationPort, response);
  }

  private withSessionTimeout(user: RadiusUser, secondsLeft: number): RadiusUser {
    const reply = user.replyAttributes ?? [];
    const existing = reply.find((attribute) => attribute.type === 'session-timeout');
    if (existing === undefined) return { ...user, replyAttributes: [...reply, attr('session-timeout', secondsLeft)] };
    if (Number(existing.value) <= secondsLeft) return user;
    return { ...user, replyAttributes: reply.map((attribute) => (attribute === existing ? attr('session-timeout', secondsLeft) : attribute)) };
  }

  private pruneDedupCache(): void {
    const cutoff = simulationNowMs() - DEDUP_TTL_MS;
    for (const [key, entry] of this.recentReplies) {
      if (entry.sentAt < cutoff) this.recentReplies.delete(key);
    }
  }

  private pruneChallenges(): void {
    const now = simulationNowMs();
    for (const [key, entry] of this.challenges) {
      if (entry.expiresAt < now) this.challenges.delete(key);
    }
  }

  private pruneAcctDedupCache(): void {
    const cutoff = simulationNowMs() - DEDUP_TTL_MS;
    for (const [key, entry] of this.recentAcctReplies) {
      if (entry.sentAt < cutoff) this.recentAcctReplies.delete(key);
    }
  }

  private pruneEapSessions(): void {
    const now = simulationNowMs();
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
        this.eapTlsSessions.set(state, { session, username, expiresAt: simulationNowMs() + CHALLENGE_TTL_MS });
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
      this.eapSessions.set(state, { username, challengeHex, expiresAt: simulationNowMs() + CHALLENGE_TTL_MS });
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
    const now = simulationNowMs();
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
    ctx.expiresAt = simulationNowMs() + CHALLENGE_TTL_MS;
    const nextRequest = ctx.session.handle(eap);
    if (ctx.session.result === null) {
      this.replyEapChallenge(inPort, dstIp, clientPort, request, nextRequest, state, dedupKey);
      return;
    }
    this.eapTlsSessions.delete(state);
    const accepted = ctx.session.result === 'accept';
    const eapUser = this.config.users.get(ctx.username) ?? this.userResolver?.(ctx.username, { nasIp: dstIp.toString(), attributes: request.attributes });
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
    const trace = (accepted: boolean): void => this.emitRequestDebug(request, dstIp, username, user, accepted, [], []);
    const challengeVsa = getVsa(request, MICROSOFT_VENDOR_ID, 11);
    const blob = hexToBytes(String(responseVsa.value));
    if (!challengeVsa || blob.length < 50) {
      trace(false);
      this.publishRejected(dstIp.toString(), username, 'bad-password');
      this.reply(inPort, dstIp, clientPort, request, false, undefined, dedupKey);
      return;
    }
    if (!user) {
      trace(false);
      this.publishRejected(dstIp.toString(), username, 'unknown-user');
      this.reply(inPort, dstIp, clientPort, request, false, undefined, dedupKey);
      return;
    }

    const authChallenge = hexToBytes(String(challengeVsa.value));
    const peerChallenge = blob.subarray(2, 18);
    const ntResponse = blob.subarray(26, 50);

    const expected = generateNtResponse(authChallenge, peerChallenge, username, user.password);
    if (bytesToHex(expected) !== bytesToHex(ntResponse)) {
      trace(false);
      this.publishRejected(dstIp.toString(), username, 'bad-password');
      this.reply(inPort, dstIp, clientPort, request, false, undefined, dedupKey);
      return;
    }

    const denial = this.simultaneousUseDenial(user, username);
    if (denial !== null) {
      trace(true);
      this.publishRejected(dstIp.toString(), username, 'simultaneous-use');
      this.reply(inPort, dstIp, clientPort, request, false, user, dedupKey, denial);
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
      attr('vendor-specific', encryptMppeKey(sendKey, this.secretFor(dstIp), request.authenticator, randomSalt()), { id: MICROSOFT_VENDOR_ID, type: 16 }),
      attr('vendor-specific', encryptMppeKey(recvKey, this.secretFor(dstIp), request.authenticator, randomSalt()), { id: MICROSOFT_VENDOR_ID, type: 17 }),
    ];
    if (user.replyAttributes) attrs.push(...user.replyAttributes);
    this.emitRequestDebug(request, dstIp, username, user, true, [], attrs);
    this.publishDecision(request, dstIp, true);

    let response: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: request.identifier,
      authenticator: '00'.repeat(16), attributes: attrs,
    };
    response = withMessageAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    response = withResponseAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    this.recentReplies.set(dedupKey, { response, sentAt: simulationNowMs() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier, username: user.username,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.authSource(), response);
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
    response = withMessageAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    response = withResponseAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    this.recentReplies.set(dedupKey, { response, sentAt: simulationNowMs() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier, username: null,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.authSource(), response);
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
    const denial = accepted && user ? this.simultaneousUseDenial(user, user.username) : null;
    if (denial !== null) {
      accepted = false;
      eapResult = { type: 'eap', code: 'failure', identifier: eapResult.identifier };
      this.publishRejected(dstIp.toString(), user!.username, 'simultaneous-use');
    }
    const attrs: RadiusAttribute[] = [attr('eap-message', eapPacketToWireHex(eapResult))];
    this.publishDecision(request, dstIp, accepted, denial?.note);
    if (denial !== null) attrs.push(...denial.reply);
    if (accepted && user?.replyAttributes) attrs.push(...user.replyAttributes);
    let response: RadiusPacket = {
      type: 'radius', code: accepted ? 'access-accept' : 'access-reject', identifier: request.identifier,
      authenticator: '00'.repeat(16), attributes: attrs,
    };
    response = withMessageAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    response = withResponseAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    this.recentReplies.set(dedupKey, { response, sentAt: simulationNowMs() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: dstIp.toString(), code: response.code,
        identifier: response.identifier, username: user?.username ?? null,
      },
    });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.authSource(), response);
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
    this.challenges.set(state, { username: user.username, expiresAt: simulationNowMs() + CHALLENGE_TTL_MS });
    let response: RadiusPacket = {
      type: 'radius', code: 'access-challenge', identifier: request.identifier,
      authenticator: '00'.repeat(16),
      attributes: [attr('state', state), attr('reply-message', user.challenge!.prompt)],
    };
    response = withMessageAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    response = withResponseAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    this.recentReplies.set(dedupKey, { response, sentAt: simulationNowMs() });
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
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.authSource(), response);
    Logger.info(this.host.id, 'radius:challenge',
      `${this.host.name}: ${dstIp} Access-Challenge for ${user.username}`);
  }

  private reply(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    accepted: boolean, user: RadiusUser | undefined, dedupKey: string,
    denial: { reply: RadiusAttribute[]; note: string } | null = null,
    rejectExtra: readonly RadiusAttribute[] = [],
  ): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const replyAttrs: RadiusAttribute[] = [];
    if (accepted && user?.replyAttributes) replyAttrs.push(...user.replyAttributes);
    const rejectMessage = this.config.rejectReplyMessage === undefined ? 'Authentication failed' : this.config.rejectReplyMessage;
    if (denial !== null) replyAttrs.push(...denial.reply);
    else if (!accepted && rejectMessage !== null) replyAttrs.push(attr('reply-message', rejectMessage));
    if (!accepted) replyAttrs.push(...rejectExtra);
    this.publishDecision(request, dstIp, accepted, denial?.note);
    let response: RadiusPacket = {
      type: 'radius',
      code: accepted ? 'access-accept' : 'access-reject',
      identifier: request.identifier,
      authenticator: '00'.repeat(16), // placeholder — replaced below once Message-Authenticator is finalized
      attributes: replyAttrs,
    };
    // RFC 2869 §5.14: Message-Authenticator must be computed and folded in
    // before the Response Authenticator itself is computed over the packet.
    response = withMessageAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    response = withResponseAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    this.recentReplies.set(dedupKey, { response, sentAt: simulationNowMs() });
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
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.authSource(), response);
    Logger.info(this.host.id, 'radius:reply',
      `${this.host.name}: ${dstIp} ${response.code} for ${user?.username ?? '(unknown)'}`);
  }

  /** Retransmission of a request already answered: replay the cached response on the wire without re-processing (no duplicate accept/reject decision, no duplicate received/rejected events). */
  private resend(inPort: string, dstIp: IPAddress, clientPort: number, response: RadiusPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.authSource(), response);
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
    response = withResponseAuthenticator(response, request.authenticator, this.secretFor(dstIp));
    this.recentAcctReplies.set(dedupKey, { response, sentAt: simulationNowMs() });
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.acctSource(), response);
  }

  private resendAcct(inPort: string, dstIp: IPAddress, clientPort: number, response: RadiusPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    this.sendRadiusFrame(inPort, port, srcIp, dstIp, clientPort, this.acctSource(), response);
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
    username: string, realm: string, route: RealmRoute, dedupKey: string, fallbacks: readonly RealmRoute[] = [], kind: 'auth' | 'acct' = 'auth',
  ): void {
    const homeSrcIp = this.host.sourceAddressFor(new IPAddress(route.homeServerIp));
    if (!homeSrcIp) {
      if (kind === 'acct') return;
      this.publishRejected(nasIp.toString(), username, 'client-not-authorized');
      this.reply(inPort, nasIp, nasPort, request, false, undefined, dedupKey);
      return;
    }

    const outIdentifier = this.freeProxyIdentifier();
    let outAuthenticator = randomRequestAuthenticator();

    const attrs: RadiusAttribute[] = kind === 'acct'
      ? [attr('user-name', username), ...request.attributes.filter((candidate) => candidate.type !== 'user-name' && candidate.type !== 'message-authenticator')]
      : [attr('user-name', username)];
    const chapAttr = kind === 'acct' ? undefined : getAttr(request, 'chap-password');
    if (chapAttr) {
      // CHAP-Password doesn't depend on the RADIUS shared secret — safe to forward verbatim across hops.
      attrs.push(attr('chap-password', String(chapAttr.value)));
      const challengeAttr = getAttr(request, 'chap-challenge');
      attrs.push(attr('chap-challenge', challengeAttr ? String(challengeAttr.value) : request.authenticator));
    } else {
      const passwordAttr = kind === 'acct' ? undefined : getAttr(request, 'user-password');
      if (passwordAttr) {
        // User-Password is encrypted per-hop: decrypt with the NAS-facing secret, re-encrypt with the home server's.
        const decrypted = decryptUserPassword(String(passwordAttr.value), this.secretFor(nasIp), request.authenticator);
        attrs.push(attr('user-password', encryptUserPassword(decrypted, route.homeSecret, outAuthenticator)));
      }
    }
    if (kind === 'auth') attrs.push(attr('nas-ip-address', homeSrcIp.toString()));

    let outbound: RadiusPacket = {
      type: 'radius', code: kind === 'acct' ? 'accounting-request' : 'access-request', identifier: outIdentifier,
      authenticator: outAuthenticator, attributes: attrs,
    };
    if (kind === 'acct') {
      outbound = withAccountingRequestAuthenticator(outbound, route.homeSecret);
      outAuthenticator = outbound.authenticator;
    }

    const timer = this.getScheduler().setTimeout(() => {
      this.pendingProxy.delete(outIdentifier);
      const activity = this.homeActivity.get(`${route.homeServerIp}:${route.homePort}`) ?? { lastReplyMs: null, timedOutAtMs: null };
      if (activity.timedOutAtMs === null) activity.timedOutAtMs = simulationNowMs();
      this.homeActivity.set(`${route.homeServerIp}:${route.homePort}`, activity);
      this.startProbing(route, kind === 'acct');
      if (fallbacks.length > 0) this.forwardToRealm(inPort, nasIp, nasPort, request, username, realm, fallbacks[0], dedupKey, fallbacks.slice(1), kind);
    }, route.timeoutMs);

    this.pendingProxy.set(outIdentifier, {
      nasInPort: inPort, nasIp: nasIp.toString(), nasPort,
      originalIdentifier: request.identifier, originalAuthenticator: request.authenticator,
      nasSecret: this.secretFor(nasIp),
      homeServerIp: route.homeServerIp, homePort: route.homePort, homeSecret: route.homeSecret,
      outAuthenticator, dedupKey, timer, kind,
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
    this.host.sendUdpDatagram({
      destination: new IPAddress(route.homeServerIp), source: homeSrcIp,
      destinationPort: route.homePort, sourcePort: kind === 'acct' ? this.acctSource() : this.config.port,
      payload: outbound, payloadBytes: 20 + 16 - 8,
    });
  }

  private freeProxyIdentifier(): number {
    let identifier = this.nextProxyIdentifier;
    for (let i = 0; i < 256 && (this.pendingProxy.has(identifier) || this.pendingProbes.has(identifier)); i++) identifier = (identifier + 1) & 0xff;
    this.nextProxyIdentifier = (identifier + 1) & 0xff;
    return identifier;
  }

  private startProbing(route: RealmRoute, accounting: boolean): void {
    const key = `${route.homeServerIp}:${route.homePort}`;
    if (route.statusCheck === undefined || this.probeLoops.has(key)) return;
    const loop = { timer: null as TimerHandle | null, answers: 0, route, accounting };
    this.probeLoops.set(key, loop);
    const tick = (): void => {
      const check = route.statusCheck!;
      const homeSrcIp = this.host.sourceAddressFor(new IPAddress(route.homeServerIp));
      if (homeSrcIp) {
        const identifier = this.freeProxyIdentifier();
        const authenticator = randomRequestAuthenticator();
        const probe = withMessageAuthenticator(
          { type: 'radius', code: 'status-server', identifier, authenticator, attributes: [] }, authenticator, route.homeSecret,
        );
        const timer = this.getScheduler().setTimeout(() => {
          this.pendingProbes.delete(identifier);
          loop.answers = 0;
        }, check.timeoutMs);
        this.pendingProbes.set(identifier, { key, authenticator, secret: route.homeSecret, address: route.homeServerIp, port: route.homePort, timer });
        this.host.sendUdpDatagram({
          destination: new IPAddress(route.homeServerIp), source: homeSrcIp,
          destinationPort: route.homePort, sourcePort: accounting ? this.acctSource() : this.config.port,
          payload: probe, payloadBytes: 20 + 16 - 8,
        });
      }
      loop.timer = this.getScheduler().setTimeout(tick, check.intervalMs);
    };
    loop.timer = this.getScheduler().setTimeout(tick, route.statusCheck.intervalMs);
  }

  private tryCompleteProbe(srcIp: IPAddress, udp: UDPPacket, payload: RadiusPacket): boolean {
    const probe = this.pendingProbes.get(payload.identifier);
    if (probe === undefined || srcIp.toString() !== probe.address || udp.sourcePort !== probe.port) return false;
    if (!verifyResponseAuthenticator(payload, probe.authenticator, probe.secret)) return false;
    this.pendingProbes.delete(payload.identifier);
    if (probe.timer !== null) this.getScheduler().clear(probe.timer);
    const loop = this.probeLoops.get(probe.key);
    if (loop === undefined) return true;
    loop.answers++;
    if (loop.answers >= (loop.route.statusCheck?.answers ?? 1)) {
      if (loop.timer !== null) this.getScheduler().clear(loop.timer);
      this.probeLoops.delete(probe.key);
      this.homeActivity.set(probe.key, { lastReplyMs: simulationNowMs(), timedOutAtMs: null });
    }
    return true;
  }

  /** The home server's Access-Accept/Reject for a request we forwarded — translate it back to the original NAS. Returns false when the reply doesn't match any pending proxied request (so the caller can fall through to normal handling). */
  private tryCompleteProxyReply(srcIp: IPAddress, udp: UDPPacket, payload: RadiusPacket): boolean {
    if (this.tryCompleteProbe(srcIp, udp, payload)) return true;
    const ctx = this.pendingProxy.get(payload.identifier);
    if (!ctx) return false;
    if (srcIp.toString() !== ctx.homeServerIp || udp.sourcePort !== ctx.homePort) return false;
    if (!verifyResponseAuthenticator(payload, ctx.outAuthenticator, ctx.homeSecret)) return false;

    this.pendingProxy.delete(payload.identifier);
    if (ctx.timer !== null) this.getScheduler().clear(ctx.timer);
    this.homeActivity.set(`${ctx.homeServerIp}:${ctx.homePort}`, { lastReplyMs: simulationNowMs(), timedOutAtMs: null });

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
    if (ctx.kind === 'auth') response = withMessageAuthenticator(response, ctx.originalAuthenticator, ctx.nasSecret);
    response = withResponseAuthenticator(response, ctx.originalAuthenticator, ctx.nasSecret);
    (ctx.kind === 'acct' ? this.recentAcctReplies : this.recentReplies).set(ctx.dedupKey, { response, sentAt: simulationNowMs() });
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: ctx.nasIp, code: response.code,
        identifier: response.identifier, username: null,
      },
    });
    this.sendRadiusFrame(ctx.nasInPort, port, nasSrcIp, new IPAddress(ctx.nasIp), ctx.nasPort, ctx.kind === 'acct' ? this.acctSource() : this.config.port, response);
    Logger.info(this.host.id, 'radius:proxy',
      `${this.host.name}: proxied ${response.code} from ${ctx.homeServerIp} → NAS ${ctx.nasIp}`);
    return true;
  }

  /** Egress toward an arbitrary target IP (the home server, typically off-subnet) — mirrors `RadiusClientAgent`'s own resolver. */

  private sendRadiusFrame(
    inPort: string, port: Port, srcIp: IPAddress, dstIp: IPAddress,
    clientPort: number, sourcePort: number, response: RadiusPacket,
  ): void {
    this.traceSent(response, srcIp, sourcePort, dstIp, clientPort);
    if (this.streamSink !== null) {
      this.streamSink(response);
      return;
    }
    if (dstIp.isLoopback() || dstIp.toString() === srcIp.toString()) {
      this.host.sendUdpDatagram({
        destination: dstIp, destinationPort: clientPort, sourcePort, payload: response, payloadBytes: 20 + 16 - 8, source: srcIp,
      });
      return;
    }
    const ipPkt = buildUdpOverIpv4(srcIp, {
      destination: dstIp,
      destinationPort: clientPort, sourcePort,
      payload: response, payloadBytes: 20 + 16 - 8,
    });
    this.host.sendIpv4FrameArpAware(inPort, ipPkt, dstIp);
  }
}

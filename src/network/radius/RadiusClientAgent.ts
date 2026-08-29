import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { hexToBytes, bytesToHex, bytesToUtf8 } from '@/crypto/encoding';
import {
  type RadiusClientConfig, type RadiusServerConfig, type RadiusPacket,
  type RadiusAttribute,
  createDefaultClientConfig, defaultServerEntry, attr, getAttr, getVsa,
  encryptUserPassword,
  UDP_PORT_RADIUS_AUTH,
} from './types';
import {
  randomRequestAuthenticator, randomOpaqueToken, withMessageAuthenticator,
  verifyResponseAuthenticator, verifyMessageAuthenticator,
} from './authenticators';
import { buildChapPasswordHex } from './passwords';
import { NAS_PORT_TYPE_ETHERNET } from './eap';
import { MICROSOFT_VENDOR_ID } from './dictionary';
import { generateNtResponse, generateAuthenticatorResponse } from './mschapv2';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type IPv4Packet, type UDPPacket,
} from '../core/types';
import { Logger } from '../core/Logger';
import { type UdpSendRequest } from '../layers/transport/UdpEgress';

export interface RadiusClientHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  /** ARP-aware send (queues on a cold cache instead of broadcasting) — falls back to broadcast when absent (mirrors `TcpHost`). */
  sendIpv4FrameArpAware?(outPortName: string, ipPkt: IPv4Packet, nextHopIP: IPAddress): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  sourceAddressFor(destination: IPAddress): IPAddress | null;
}

type RadiusAuthMethod = 'pap' | 'chap';
/** Outcome of a single request/response round, distinct from the public accept/reject boolean: only 'timeout' triggers failover to the next server — an explicit reject is authoritative. */
type RadiusRoundResult = 'accept' | 'reject' | 'timeout';

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
  resolve: (result: RadiusRoundResult) => void;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

interface ServerRuntimeState {
  /** ms epoch until which the server is treated as dead (skipped in ordering); null = alive. */
  deadUntil: number | null;
  stats: { requests: number; accepts: number; rejects: number; timeouts: number };
}

export interface RadiusServerStatus {
  ip: string;
  alive: boolean;
  deadUntil: number | null;
  requests: number;
  accepts: number;
  rejects: number;
  timeouts: number;
}

const DEFAULT_MAX_CHALLENGE_ROUNDS = 1;

/**
 * Outcome of one EAP-relay round (RFC 3579). Unlike authenticate()/
 * authenticateChap(), the caller (an 802.1X authenticator) drives the
 * multi-round conversation itself — each round waits for its own external
 * party (the supplicant) between RADIUS legs, so it can't be automatic like
 * the generic Access-Challenge continuation.
 */
export type EapRoundOutcome =
  | { kind: 'challenge'; eapMessageHex: string; state: string | null }
  | { kind: 'accept'; eapMessageHex: string | null; attributes: RadiusAttribute[] }
  | { kind: 'reject'; eapMessageHex: string | null }
  | { kind: 'timeout' };

interface PendingEapRound {
  identifier: number;
  serverIp: string;
  secret: string;
  authenticator: string;
  username: string;
  eapMessageHex: string;
  state: string | null;
  callingStationId?: string;
  calledStationId?: string;
  resolve: (outcome: EapRoundOutcome) => void;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

/**
 * Outcome of an MS-CHAPv2 authentication (RFC 2759, carried per RFC 2548).
 * Unlike EAP, all the crypto (challenges, NT-Response) is computed by the
 * peer *before* the RADIUS exchange, so this is a single round-trip like
 * authenticate()/authenticateChap() — no external party to wait on mid-flight.
 */
export type MsChapV2Outcome =
  | { kind: 'accept'; authenticatorResponseValid: boolean; attributes: RadiusAttribute[] }
  | { kind: 'reject' }
  | { kind: 'timeout' };

interface PendingMsChapRound {
  identifier: number;
  serverIp: string;
  secret: string;
  authenticator: string;
  username: string;
  password: string;
  authChallenge: Uint8Array;
  peerChallenge: Uint8Array;
  ntResponse: Uint8Array;
  resolve: (outcome: MsChapV2Outcome) => void;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

export class RadiusClientAgent {
  private config: RadiusClientConfig = createDefaultClientConfig();
  private pending = new Map<number, PendingRequest>();
  private pendingEap = new Map<number, PendingEapRound>();
  private pendingMsChap = new Map<number, PendingMsChapRound>();
  private nextIdentifier = 1;
  private scheduler: IScheduler | null = null;
  private running = false;
  private serverStates = new Map<string, ServerRuntimeState>();
  /** `radius-server deadtime` equivalent — 0 disables cross-request server avoidance (Cisco default). */
  private deadtimeMs = 0;
  /**
   * Override the identifier-derived ephemeral source port with a fixed one.
   * Needed on hosts whose UDP model is destination-port-bound (`EndHost`'s
   * socket table) rather than Router's inline per-packet dispatch — a
   * client agent hosted there (e.g. `radtest`) must reply-listen on one
   * `udpBind`-registered port, not whichever port a given request happens
   * to pick. `null` (default) preserves the original identifier-derived port.
   */
  private fixedSourcePort: number | null = null;

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
      p.resolve('timeout'); // the !this.running guard in tryServers() stops this from cascading to another server
    }
    this.pending.clear();
    for (const p of this.pendingEap.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
      p.resolve({ kind: 'timeout' });
    }
    this.pendingEap.clear();
    for (const p of this.pendingMsChap.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
      p.resolve({ kind: 'timeout' });
    }
    this.pendingMsChap.clear();
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
    this.serverStates.delete(ip);
  }

  setNasIdentifier(id: string | null): void { this.config.nasIdentifier = id; }
  setSourceInterface(iface: string | null): void { this.config.sourceInterface = iface; }

  /** `radius-server deadtime <minutes>` equivalent, taking milliseconds. 0 (default) disables it. */
  setDeadtimeMs(ms: number): void { this.deadtimeMs = Math.max(0, ms); }

  /** See `fixedSourcePort`'s doc comment. */
  setFixedSourcePort(port: number | null): void { this.fixedSourcePort = port; }

  listServers(): RadiusServerConfig[] { return this.config.servers.slice(); }

  /** Per-server liveness + request/accept/reject/timeout counters (`show radius statistics` material). */
  listServerStatus(): RadiusServerStatus[] {
    const now = Date.now();
    return this.config.servers.map((s) => {
      const state = this.stateFor(s.ip);
      return {
        ip: s.ip, alive: !this.isDead(s.ip, now), deadUntil: state.deadUntil,
        requests: state.stats.requests, accepts: state.stats.accepts,
        rejects: state.stats.rejects, timeouts: state.stats.timeouts,
      };
    });
  }

  /** PAP authentication (RFC 2865 §5.2 User-Password). */
  authenticate(username: string, password: string, serverIp?: string): Promise<boolean> {
    return this.run(username, password, 'pap', serverIp);
  }

  /** CHAP authentication (RFC 2865 §5.3, RFC 1994). */
  authenticateChap(username: string, password: string, serverIp?: string): Promise<boolean> {
    return this.run(username, password, 'chap', serverIp);
  }

  /**
   * MS-CHAPv2 authentication (RFC 2759, carried as Microsoft VSAs per RFC
   * 2548 §2.3): generates the AuthenticatorChallenge/PeerChallenge/NT-Response
   * itself (this simulator collapses the NAS and the dial-in peer into one
   * caller, same simplification `authenticate()`/`authenticateChap()` already
   * make), sends a single Access-Request, and — on accept — checks the
   * server's MS-CHAP2-Success mutual-auth proof against what the real
   * password would produce.
   */
  authenticateMsChapV2(username: string, password: string, serverIp?: string): Promise<MsChapV2Outcome> {
    if (!this.config.enabled) return Promise.resolve({ kind: 'timeout' });
    const server = serverIp
      ? this.config.servers.find((s) => s.ip === serverIp)
      : this.config.servers[0];
    if (!server) return Promise.resolve({ kind: 'timeout' });
    const identifier = this.nextIdentifier;
    this.nextIdentifier = (this.nextIdentifier + 1) & 0xff;
    const authenticator = randomRequestAuthenticator();
    const authChallenge = hexToBytes(randomOpaqueToken(16));
    const peerChallenge = hexToBytes(randomOpaqueToken(16));
    const ntResponse = generateNtResponse(authChallenge, peerChallenge, username, password);
    return new Promise<MsChapV2Outcome>((resolve) => {
      const pending: PendingMsChapRound = {
        identifier, serverIp: server.ip, secret: server.sharedSecret, authenticator,
        username, password, authChallenge, peerChallenge, ntResponse,
        resolve, timer: null, attemptsLeft: server.retransmit,
      };
      this.pendingMsChap.set(identifier, pending);
      this.transmitMsChap(server, pending);
      this.armMsChapTimeout(server, pending);
    });
  }

  /**
   * Send one EAP-relay round (RFC 3579): a single Access-Request carrying
   * `eapMessageHex` (and `state`, when replying to a previous
   * Access-Challenge), with retransmission. The caller (802.1X) is
   * responsible for driving further rounds after relaying the outcome to
   * the supplicant — this does not try other servers on timeout, unlike
   * authenticate()/authenticateChap(), since an EAP conversation is bound
   * to whichever server issued the challenge being answered.
   */
  sendEapRound(
    username: string, eapMessageHex: string, state: string | null,
    nas: { callingStationId?: string; calledStationId?: string } = {},
    serverIp?: string,
  ): Promise<EapRoundOutcome> {
    if (!this.config.enabled) return Promise.resolve({ kind: 'timeout' });
    const server = serverIp
      ? this.config.servers.find((s) => s.ip === serverIp)
      : this.config.servers[0];
    if (!server) return Promise.resolve({ kind: 'timeout' });
    const identifier = this.nextIdentifier;
    this.nextIdentifier = (this.nextIdentifier + 1) & 0xff;
    const authenticator = randomRequestAuthenticator();
    return new Promise<EapRoundOutcome>((resolve) => {
      const pending: PendingEapRound = {
        identifier, serverIp: server.ip, secret: server.sharedSecret, authenticator,
        username, eapMessageHex, state,
        callingStationId: nas.callingStationId, calledStationId: nas.calledStationId,
        resolve, timer: null, attemptsLeft: server.retransmit,
      };
      this.pendingEap.set(identifier, pending);
      this.transmitEap(server, pending);
      this.armEapTimeout(server, pending);
    });
  }

  private transmitEap(server: RadiusServerConfig, pending: PendingEapRound): void {
    const srcIp = this.host.sourceAddressFor(new IPAddress(server.ip));
    if (!srcIp) return;
    const attrs: RadiusAttribute[] = [
      attr('user-name', pending.username),
      attr('nas-ip-address', srcIp.toString()),
      attr('nas-port-type', NAS_PORT_TYPE_ETHERNET),
      attr('eap-message', pending.eapMessageHex),
    ];
    if (pending.callingStationId) attrs.push(attr('calling-station-id', pending.callingStationId));
    if (pending.calledStationId) attrs.push(attr('called-station-id', pending.calledStationId));
    if (pending.state) attrs.push(attr('state', pending.state));
    if (this.config.nasIdentifier) attrs.push(attr('nas-identifier', this.config.nasIdentifier));
    let payload: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: pending.identifier,
      authenticator: pending.authenticator, attributes: attrs,
    };
    payload = withMessageAuthenticator(payload, pending.authenticator, server.sharedSecret);
    const datagram = {
      destination: new IPAddress(server.ip),
      destinationPort: server.authPort, sourcePort: 49180 + (pending.identifier & 0x3fff),
      payload, payloadBytes: 12,
      source: srcIp,
    };
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: server.ip, code: 'access-request',
        identifier: pending.identifier, username: pending.username,
      },
    });
    this.host.sendUdpDatagram(datagram);
  }

  private armEapTimeout(server: RadiusServerConfig, pending: PendingEapRound): void {
    const s = this.getScheduler();
    this.scheduler = s;
    pending.timer = s.setTimeout(() => {
      if (!this.pendingEap.has(pending.identifier)) return;
      if (pending.attemptsLeft > 0) {
        pending.attemptsLeft--;
        this.transmitEap(server, pending);
        this.armEapTimeout(server, pending);
      } else {
        this.pendingEap.delete(pending.identifier);
        pending.resolve({ kind: 'timeout' });
      }
    }, server.timeoutMs);
  }

  private handleEapUdp(payload: RadiusPacket, srcIp: IPAddress, pending: PendingEapRound): void {
    if (pending.serverIp !== srcIp.toString()) return;
    if (!verifyResponseAuthenticator(payload, pending.authenticator, pending.secret)) {
      Logger.warn(this.host.id, 'radius:bad-response-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} — invalid Response Authenticator (EAP relay)`);
      return;
    }
    // RFC 3579 §3.2: Message-Authenticator is mandatory whenever EAP-Message
    // is being carried — unlike the generic case, its absence is a drop too.
    if (!getAttr(payload, 'message-authenticator')
        || !verifyMessageAuthenticator(payload, pending.authenticator, pending.secret)) {
      Logger.warn(this.host.id, 'radius:bad-message-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} — missing/invalid Message-Authenticator (EAP relay)`);
      return;
    }
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pendingEap.delete(pending.identifier);
    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), code: payload.code, identifier: payload.identifier,
      },
    });
    const eapAttr = getAttr(payload, 'eap-message');
    const eapMessageHex = eapAttr ? String(eapAttr.value) : null;
    const stateAttr = getAttr(payload, 'state');
    const state = stateAttr ? String(stateAttr.value) : null;
    if (payload.code === 'access-challenge') {
      pending.resolve({ kind: 'challenge', eapMessageHex: eapMessageHex ?? '', state });
      return;
    }
    if (payload.code === 'access-accept') {
      pending.resolve({ kind: 'accept', eapMessageHex, attributes: payload.attributes });
      return;
    }
    pending.resolve({ kind: 'reject', eapMessageHex });
  }

  private transmitMsChap(server: RadiusServerConfig, pending: PendingMsChapRound): void {
    const srcIp = this.host.sourceAddressFor(new IPAddress(server.ip));
    if (!srcIp) return;
    const msChap2Response = new Uint8Array(50);
    msChap2Response[0] = pending.identifier & 0xff; // Ident
    msChap2Response[1] = 0; // Flags
    msChap2Response.set(pending.peerChallenge, 2);
    // bytes [18, 26) are the reserved 8 zero bytes
    msChap2Response.set(pending.ntResponse, 26);
    const attrs: RadiusAttribute[] = [
      attr('user-name', pending.username),
      attr('nas-ip-address', srcIp.toString()),
      attr('nas-port-type', NAS_PORT_TYPE_ETHERNET),
      attr('vendor-specific', bytesToHex(pending.authChallenge), { id: MICROSOFT_VENDOR_ID, type: 11 }),
      attr('vendor-specific', bytesToHex(msChap2Response), { id: MICROSOFT_VENDOR_ID, type: 25 }),
    ];
    if (this.config.nasIdentifier) attrs.push(attr('nas-identifier', this.config.nasIdentifier));
    let payload: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: pending.identifier,
      authenticator: pending.authenticator, attributes: attrs,
    };
    payload = withMessageAuthenticator(payload, pending.authenticator, server.sharedSecret);
    const datagram = {
      destination: new IPAddress(server.ip),
      destinationPort: server.authPort,
      sourcePort: this.fixedSourcePort ?? (49180 + (pending.identifier & 0x3fff)),
      payload, payloadBytes: 12,
      source: srcIp,
    };
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: server.ip, code: 'access-request',
        identifier: pending.identifier, username: pending.username,
      },
    });
    this.host.sendUdpDatagram(datagram);
  }

  private armMsChapTimeout(server: RadiusServerConfig, pending: PendingMsChapRound): void {
    const s = this.getScheduler();
    this.scheduler = s;
    pending.timer = s.setTimeout(() => {
      if (!this.pendingMsChap.has(pending.identifier)) return;
      if (pending.attemptsLeft > 0) {
        pending.attemptsLeft--;
        this.transmitMsChap(server, pending);
        this.armMsChapTimeout(server, pending);
      } else {
        this.pendingMsChap.delete(pending.identifier);
        pending.resolve({ kind: 'timeout' });
      }
    }, server.timeoutMs);
  }

  private handleMsChapUdp(payload: RadiusPacket, srcIp: IPAddress, pending: PendingMsChapRound): void {
    if (pending.serverIp !== srcIp.toString()) return;
    if (!verifyResponseAuthenticator(payload, pending.authenticator, pending.secret)) {
      Logger.warn(this.host.id, 'radius:bad-response-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} for ${pending.username} — invalid Response Authenticator (MS-CHAPv2)`);
      return;
    }
    if (!verifyMessageAuthenticator(payload, pending.authenticator, pending.secret)) {
      Logger.warn(this.host.id, 'radius:bad-message-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} for ${pending.username} — invalid Message-Authenticator (MS-CHAPv2)`);
      return;
    }
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pendingMsChap.delete(pending.identifier);
    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), code: payload.code, identifier: payload.identifier,
      },
    });
    if (payload.code === 'access-accept') {
      const successVsa = getVsa(payload, MICROSOFT_VENDOR_ID, 26);
      let authenticatorResponseValid = false;
      if (successVsa) {
        const bytes = hexToBytes(String(successVsa.value));
        const message = bytesToUtf8(bytes.subarray(1)); // byte 0 is Ident
        const expected = generateAuthenticatorResponse(
          pending.password, pending.ntResponse, pending.peerChallenge, pending.authChallenge, pending.username,
        );
        authenticatorResponseValid = message.startsWith(expected);
      }
      pending.resolve({ kind: 'accept', authenticatorResponseValid, attributes: payload.attributes });
      return;
    }
    pending.resolve({ kind: 'reject' });
  }

  private run(username: string, password: string, authMethod: RadiusAuthMethod, serverIp?: string): Promise<boolean> {
    if (!this.config.enabled) return Promise.resolve(false);
    const order = this.candidateServers(serverIp);
    if (order.length === 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.tryServers(order, 0, username, password, authMethod, resolve);
    });
  }

  /** Servers in configured order, skipping ones currently marked dead — unless *all* are dead, in which case try them anyway (fail open, matching real `deadtime` semantics). */
  private candidateServers(serverIp?: string): RadiusServerConfig[] {
    if (serverIp) {
      const s = this.config.servers.find((sv) => sv.ip === serverIp);
      return s ? [s] : [];
    }
    const now = Date.now();
    const alive = this.config.servers.filter((s) => !this.isDead(s.ip, now));
    return alive.length > 0 ? alive : this.config.servers.slice();
  }

  /** Attempt `order[idx]`; on an explicit accept/reject resolve immediately (authoritative — no failover), on timeout mark it dead and move to the next server. */
  private tryServers(
    order: RadiusServerConfig[], idx: number, username: string, password: string,
    authMethod: RadiusAuthMethod, resolve: (accepted: boolean) => void,
  ): void {
    if (idx >= order.length) { resolve(false); return; }
    const server = order[idx];
    const state = this.stateFor(server.ip);
    state.stats.requests++;
    this.beginRequest(server, username, password, authMethod, null, DEFAULT_MAX_CHALLENGE_ROUNDS, (result) => {
      if (result === 'accept') {
        state.stats.accepts++;
        this.markAlive(server.ip);
        resolve(true);
        return;
      }
      if (result === 'reject') {
        state.stats.rejects++;
        this.markAlive(server.ip);
        resolve(false);
        return;
      }
      state.stats.timeouts++;
      this.markDead(server.ip);
      if (!this.running) { resolve(false); return; } // agent stopped mid-flight — don't start a new request
      this.tryServers(order, idx + 1, username, password, authMethod, resolve);
    });
  }

  private stateFor(ip: string): ServerRuntimeState {
    let s = this.serverStates.get(ip);
    if (!s) {
      s = { deadUntil: null, stats: { requests: 0, accepts: 0, rejects: 0, timeouts: 0 } };
      this.serverStates.set(ip, s);
    }
    return s;
  }

  private isDead(ip: string, now: number): boolean {
    const deadUntil = this.serverStates.get(ip)?.deadUntil;
    return !!deadUntil && deadUntil > now;
  }

  private markDead(ip: string): void {
    if (this.deadtimeMs <= 0) return;
    const state = this.stateFor(ip);
    const wasAlive = !this.isDead(ip, Date.now());
    state.deadUntil = Date.now() + this.deadtimeMs;
    if (wasAlive) {
      this.getBus().publish({
        topic: 'radius.server.dead',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), serverIp: ip },
      });
      Logger.warn(this.host.id, 'radius:server-dead',
        `${this.host.name}: RADIUS server ${ip} marked dead for ${this.deadtimeMs}ms`);
    }
  }

  private markAlive(ip: string): void {
    const state = this.serverStates.get(ip);
    if (state?.deadUntil) {
      state.deadUntil = null;
      this.getBus().publish({
        topic: 'radius.server.alive',
        payload: { deviceId: this.host.id, hostname: this.host.getHostname(), serverIp: ip },
      });
      Logger.info(this.host.id, 'radius:server-alive', `${this.host.name}: RADIUS server ${ip} responsive again`);
    }
  }

  private beginRequest(
    server: RadiusServerConfig, username: string, password: string, authMethod: RadiusAuthMethod,
    state: string | null, challengesLeft: number, resolve: (result: RadiusRoundResult) => void,
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

    const eapPending = this.pendingEap.get(payload.identifier);
    if (eapPending) { this.handleEapUdp(payload, srcIp, eapPending); return; }

    const msChapPending = this.pendingMsChap.get(payload.identifier);
    if (msChapPending) { this.handleMsChapUdp(payload, srcIp, msChapPending); return; }

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
    pending.resolve(accepted ? 'accept' : 'reject');
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
      pending.resolve('reject'); // the server did respond validly — this is a client-side give-up, not a server failure
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
        pending.resolve('timeout');
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
    const srcIp = this.host.sourceAddressFor(new IPAddress(server.ip));
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
    const datagram = {
      destination: new IPAddress(server.ip),
      destinationPort: server.authPort,
      sourcePort: this.fixedSourcePort ?? (49152 + (pending.identifier & 0x3fff)),
      payload, payloadBytes: 20 + 32 + pending.username.length + pending.password.length - 8,
      source: srcIp,
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
    this.host.sendUdpDatagram(datagram);
  }

}

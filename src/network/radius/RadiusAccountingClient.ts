import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import { type RadiusPacket, UDP_PORT_RADIUS_ACCT } from './types';
import { withAccountingRequestAuthenticator, verifyResponseAuthenticator } from './authenticators';
import { acctAttributesFor, generateAcctSessionId, type AcctRecord, type AcctTerminateCause } from './accounting';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type UDPPacket,
} from '../core/types';
import { Logger } from '../core/Logger';
import { type UdpSendRequest } from '../layers/transport/UdpEgress';

export interface RadiusAcctServerConfig {
  ip: string;
  acctPort: number;
  sharedSecret: string;
  timeoutMs: number;
  retransmit: number;
}

export interface RadiusAccountingHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  sendUdpDatagram(request: UdpSendRequest): boolean;
  sourceAddressFor(destination: IPAddress): IPAddress | null;
}

export interface RadiusAcctSessionInfo {
  sessionId: string;
  username: string;
  startedAt: number;
  inputOctets: number;
  outputOctets: number;
}

interface ActiveSession {
  sessionId: string;
  username: string;
  server: RadiusAcctServerConfig;
  startedAt: number;
  inputOctets: number;
  outputOctets: number;
}

interface PendingAcct {
  identifier: number;
  server: RadiusAcctServerConfig;
  record: AcctRecord;
  /** Set once transmit() computes it — needed to verify the matching Accounting-Response. */
  authenticator: string;
  firstAttemptAt: number;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

/** NAS-side RADIUS accounting client (RFC 2866): Start/Interim-Update/Stop with retransmission. */
export class RadiusAccountingClient {
  private servers: RadiusAcctServerConfig[] = [];
  private sessions = new Map<string, ActiveSession>();
  private pending = new Map<number, PendingAcct>();
  private nextIdentifier = 1;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: RadiusAccountingHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }

  stop(): void {
    this.running = false;
    for (const p of this.pending.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
    }
    this.pending.clear();
  }

  addServer(ip: string, sharedSecret: string, opts: { port?: number; timeoutMs?: number; retransmit?: number } = {}): void {
    const acctPort = opts.port ?? UDP_PORT_RADIUS_ACCT;
    const existing = this.servers.find((s) => s.ip === ip);
    if (existing) {
      existing.sharedSecret = sharedSecret;
      existing.acctPort = acctPort;
      if (opts.timeoutMs) existing.timeoutMs = opts.timeoutMs;
      if (opts.retransmit !== undefined) existing.retransmit = opts.retransmit;
      return;
    }
    this.servers.push({
      ip, acctPort, sharedSecret,
      timeoutMs: opts.timeoutMs ?? 5000, retransmit: opts.retransmit ?? 2,
    });
  }

  removeServer(ip: string): void { this.servers = this.servers.filter((s) => s.ip !== ip); }
  listServers(): RadiusAcctServerConfig[] { return this.servers.slice(); }

  listSessions(): RadiusAcctSessionInfo[] {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId, username: s.username, startedAt: s.startedAt,
      inputOctets: s.inputOctets, outputOctets: s.outputOctets,
    }));
  }

  /** Begin a session and send Acct-Start. Returns the generated session id, or null if no server is configured. */
  startSession(username: string, serverIp?: string): string | null {
    const server = serverIp ? this.servers.find((s) => s.ip === serverIp) : this.servers[0];
    if (!server) return null;
    const sessionId = generateAcctSessionId();
    this.sessions.set(sessionId, {
      sessionId, username, server, startedAt: Date.now(), inputOctets: 0, outputOctets: 0,
    });
    this.send(server, {
      sessionId, username, nasIp: '0.0.0.0', status: 'start',
      delaySec: 0, sessionTimeSec: 0, inputOctets: 0, outputOctets: 0,
    });
    return sessionId;
  }

  /** Send an Acct-Interim-Update reflecting cumulative counters for an active session. */
  interimUpdate(sessionId: string, opts: { inputOctets?: number; outputOctets?: number } = {}): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (opts.inputOctets !== undefined) session.inputOctets = opts.inputOctets;
    if (opts.outputOctets !== undefined) session.outputOctets = opts.outputOctets;
    this.send(session.server, {
      sessionId, username: session.username, nasIp: '0.0.0.0', status: 'interim-update',
      delaySec: 0, sessionTimeSec: elapsedSeconds(session.startedAt),
      inputOctets: session.inputOctets, outputOctets: session.outputOctets,
    });
  }

  /** Close a session with Acct-Stop and stop tracking it locally. */
  stopSession(sessionId: string, cause: AcctTerminateCause = 'user-request'): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.send(session.server, {
      sessionId, username: session.username, nasIp: '0.0.0.0', status: 'stop',
      delaySec: 0, sessionTimeSec: elapsedSeconds(session.startedAt),
      inputOctets: session.inputOctets, outputOctets: session.outputOctets,
      terminateCause: cause,
    });
    this.sessions.delete(sessionId);
  }

  handleUdp(_inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius' || payload.code !== 'accounting-response') return;
    const pending = this.pending.get(payload.identifier);
    if (!pending) return;
    if (pending.server.ip !== srcIp.toString()) return;
    if (!verifyResponseAuthenticator(payload, pending.authenticator, pending.server.sharedSecret)) {
      Logger.warn(this.host.id, 'radius:bad-response-authenticator',
        `${this.host.name}: dropped Accounting-Response from ${srcIp} — invalid Response Authenticator`);
      return;
    }
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pending.delete(payload.identifier);
    this.getBus().publish({
      topic: 'radius.packet.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: srcIp.toString(), code: payload.code, identifier: payload.identifier,
      },
    });
    Logger.info(this.host.id, 'radius:accounting',
      `${this.host.name}: ${pending.record.status} acknowledged for ${pending.record.sessionId} (${pending.record.username})`);
  }

  private send(server: RadiusAcctServerConfig, record: AcctRecord): void {
    const identifier = this.nextIdentifier;
    this.nextIdentifier = (this.nextIdentifier + 1) & 0xff;
    const pending: PendingAcct = {
      identifier, server, record, authenticator: '',
      firstAttemptAt: Date.now(), timer: null, attemptsLeft: server.retransmit,
    };
    this.pending.set(identifier, pending);
    this.transmit(pending);
    this.armTimeout(pending);
  }

  private armTimeout(pending: PendingAcct): void {
    const s = this.getScheduler();
    this.scheduler = s;
    pending.timer = s.setTimeout(() => {
      if (!this.pending.has(pending.identifier)) return;
      if (pending.attemptsLeft > 0) {
        pending.attemptsLeft--;
        this.transmit(pending);
        this.armTimeout(pending);
      } else {
        this.pending.delete(pending.identifier);
        Logger.warn(this.host.id, 'radius:acct-timeout',
          `${this.host.name}: ${pending.record.status} for ${pending.record.sessionId} never acknowledged`);
      }
    }, pending.server.timeoutMs);
  }

  private transmit(pending: PendingAcct): void {
    const srcIp = this.host.sourceAddressFor(new IPAddress(pending.server.ip));
    if (!srcIp) return;
    const record: AcctRecord = {
      ...pending.record, nasIp: srcIp.toString(),
      delaySec: elapsedSeconds(pending.firstAttemptAt),
    };
    let payload: RadiusPacket = {
      type: 'radius', code: 'accounting-request', identifier: pending.identifier,
      authenticator: '00'.repeat(16),
      attributes: acctAttributesFor(record),
    };
    payload = withAccountingRequestAuthenticator(payload, pending.server.sharedSecret);
    pending.authenticator = payload.authenticator;
    const datagram = {
      destination: new IPAddress(pending.server.ip),
      destinationPort: pending.server.acctPort, sourcePort: 49200 + (pending.identifier & 0x3fff),
      payload, payloadBytes: 12,
      source: srcIp,
    };
    this.getBus().publish({
      topic: 'radius.packet.sent',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        destinationIp: pending.server.ip, code: 'accounting-request',
        identifier: pending.identifier, username: pending.record.username,
      },
    });
    this.host.sendUdpDatagram(datagram);
  }

}

function elapsedSeconds(sinceMs: number): number {
  return Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
}

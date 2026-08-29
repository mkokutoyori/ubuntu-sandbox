import type { IEventBus } from '@/events/EventBus';
import { getDefaultScheduler, type IScheduler, type TimerHandle } from '@/events/Scheduler';
import {
  type RadiusPacket, type RadiusAttribute,
  attr, UDP_PORT_RADIUS_COA,
} from './types';
import {
  withAccountingRequestAuthenticator, verifyResponseAuthenticator,
} from './authenticators';
import { type ErrorCause, readErrorCause } from './coa';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type UDPPacket,
  ETHERTYPE_IPV4,
} from '../core/types';
import { Logger } from '../core/Logger';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';

export interface CoaNasTarget {
  ip: string;
  port: number;
  sharedSecret: string;
  timeoutMs: number;
  retransmit: number;
}

export interface CoaClientHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  resolveMac?(ip: string): MACAddress | null;
  resolveRoute?(targetIp: string): { iface: string; nextHopIp: string } | null;
}

export type CoaResult =
  | { kind: 'ack' }
  | { kind: 'nak'; errorCause: ErrorCause | null }
  | { kind: 'timeout' };

interface PendingCoa {
  identifier: number;
  nas: CoaNasTarget;
  request: RadiusPacket;
  isDisconnect: boolean;
  resolve: (result: CoaResult) => void;
  timer: TimerHandle | null;
  attemptsLeft: number;
}

/** RFC 5176 — the dynamic authorization client (typically colocated with the RADIUS server): sends CoA-Request/Disconnect-Request to a NAS and awaits ACK/NAK. */
export class CoaClient {
  private nas: CoaNasTarget[] = [];
  private pending = new Map<number, PendingCoa>();
  private nextIdentifier = 1;
  private scheduler: IScheduler | null = null;
  private running = false;

  constructor(
    private readonly host: CoaClientHost,
    private readonly getBus: () => IEventBus,
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void {
    this.running = false;
    for (const p of this.pending.values()) {
      if (p.timer !== null) (this.scheduler ?? this.getScheduler()).clear(p.timer);
      p.resolve({ kind: 'timeout' });
    }
    this.pending.clear();
  }

  addNas(ip: string, sharedSecret: string, opts: { port?: number; timeoutMs?: number; retransmit?: number } = {}): void {
    const port = opts.port ?? UDP_PORT_RADIUS_COA;
    const existing = this.nas.find((n) => n.ip === ip);
    if (existing) {
      existing.sharedSecret = sharedSecret;
      existing.port = port;
      if (opts.timeoutMs) existing.timeoutMs = opts.timeoutMs;
      if (opts.retransmit !== undefined) existing.retransmit = opts.retransmit;
      return;
    }
    this.nas.push({ ip, port, sharedSecret, timeoutMs: opts.timeoutMs ?? 5000, retransmit: opts.retransmit ?? 2 });
  }

  removeNas(ip: string): void { this.nas = this.nas.filter((n) => n.ip !== ip); }
  listNas(): CoaNasTarget[] { return this.nas.slice(); }

  /** RFC 5176 §3.3: terminate a session on the NAS. */
  disconnect(nasIp: string, ids: { username?: string; acctSessionId?: string; callingStationId?: string }): Promise<CoaResult> {
    return this.send(nasIp, 'disconnect-request', this.identifierAttrs(ids));
  }

  /** RFC 5176 §3.2: re-authorize an existing session (e.g. new VLAN, new ACL). */
  coaRequest(
    nasIp: string, ids: { username?: string; acctSessionId?: string; callingStationId?: string },
    authorizationAttrs: RadiusAttribute[],
  ): Promise<CoaResult> {
    return this.send(nasIp, 'coa-request', [...this.identifierAttrs(ids), ...authorizationAttrs]);
  }

  private identifierAttrs(ids: { username?: string; acctSessionId?: string; callingStationId?: string }): RadiusAttribute[] {
    const attrs: RadiusAttribute[] = [];
    if (ids.username) attrs.push(attr('user-name', ids.username));
    if (ids.acctSessionId) attrs.push(attr('acct-session-id', ids.acctSessionId));
    if (ids.callingStationId) attrs.push(attr('calling-station-id', ids.callingStationId));
    return attrs;
  }

  private send(nasIp: string, code: 'disconnect-request' | 'coa-request', attrs: RadiusAttribute[]): Promise<CoaResult> {
    const nas = this.nas.find((n) => n.ip === nasIp);
    if (!nas) return Promise.resolve({ kind: 'timeout' });
    const identifier = this.nextIdentifier;
    this.nextIdentifier = (this.nextIdentifier + 1) & 0xff;
    let request: RadiusPacket = {
      type: 'radius', code, identifier, authenticator: '00'.repeat(16), attributes: attrs,
    };
    request = withAccountingRequestAuthenticator(request, nas.sharedSecret); // RFC 5176 §3: same formula as Accounting-Request
    return new Promise<CoaResult>((resolve) => {
      const pending: PendingCoa = {
        identifier, nas, request, isDisconnect: code === 'disconnect-request',
        resolve, timer: null, attemptsLeft: nas.retransmit,
      };
      this.pending.set(identifier, pending);
      this.transmit(pending);
      this.armTimeout(pending);
    });
  }

  handleUdp(_inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;
    if (payload.code !== 'disconnect-ack' && payload.code !== 'disconnect-nak'
        && payload.code !== 'coa-ack' && payload.code !== 'coa-nak') return;
    const pending = this.pending.get(payload.identifier);
    if (!pending) return;
    if (pending.nas.ip !== srcIp.toString()) return;
    if (!verifyResponseAuthenticator(payload, pending.request.authenticator, pending.nas.sharedSecret)) {
      Logger.warn(this.host.id, 'radius:bad-response-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} — invalid Response Authenticator`);
      return;
    }
    if (pending.timer !== null) (this.scheduler ?? this.getScheduler()).clear(pending.timer);
    this.pending.delete(payload.identifier);
    const ack = payload.code === 'disconnect-ack' || payload.code === 'coa-ack';
    const result: CoaResult = ack ? { kind: 'ack' } : { kind: 'nak', errorCause: readErrorCause(payload) };
    this.completePending(pending, result);
  }

  private completePending(pending: PendingCoa, result: CoaResult): void {
    this.getBus().publish({
      topic: 'radius.coa.completed',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        nasIp: pending.nas.ip, code: pending.isDisconnect ? 'disconnect-request' : 'coa-request',
        result: result.kind, errorCause: result.kind === 'nak' ? result.errorCause : null,
      },
    });
    pending.resolve(result);
  }

  private armTimeout(pending: PendingCoa): void {
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
        this.completePending(pending, { kind: 'timeout' });
      }
    }, pending.nas.timeoutMs);
  }

  private transmit(pending: PendingCoa): void {
    const egress = this.resolveEgress(pending.nas.ip);
    if (!egress) return;
    const srcIp = egress.port.getIPAddress();
    if (!srcIp) return;
    const ipPkt = buildUdpOverIpv4(srcIp, {
      destination: new IPAddress(pending.nas.ip),
      destinationPort: pending.nas.port, sourcePort: 49220 + (pending.identifier & 0x3fff),
      payload: pending.request, payloadBytes: 12,
    });
    const eth: EthernetFrame = {
      srcMAC: egress.port.getMAC(),
      dstMAC: this.host.resolveMac?.(pending.nas.ip) ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(egress.name, eth);
  }

  private resolveEgress(targetIp: string): { name: string; port: import('../hardware/Port').Port } | null {
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

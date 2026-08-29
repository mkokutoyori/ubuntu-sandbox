import type { IEventBus } from '@/events/EventBus';
import {
  type RadiusPacket, type RadiusAttribute,
  getAttr, UDP_PORT_RADIUS_COA,
} from './types';
import {
  verifyAccountingRequestAuthenticator, withResponseAuthenticator,
} from './authenticators';
import {
  type ErrorCause, type CoaSessionIdentifiers,
  errorCauseAttr, readSessionIdentifiers,
} from './coa';
import {
  MACAddress, IPAddress,
  type EthernetFrame, type UDPPacket,
  ETHERTYPE_IPV4,
} from '../core/types';
import { Logger } from '../core/Logger';
import { buildUdpOverIpv4 } from '../layers/transport/UdpEgress';

export type CoaActionResult = { ok: true } | { ok: false; errorCause: ErrorCause };

/** Pluggable session store — whatever subsystem actually tracks sessions on this NAS (SSH/VTY, 802.1X ports, PPP, …) implements this. */
export interface CoaSessionHandler {
  disconnect(ids: CoaSessionIdentifiers): CoaActionResult;
  reauthorize(ids: CoaSessionIdentifiers, attributes: RadiusAttribute[]): CoaActionResult;
}

export interface CoaListenerHost {
  readonly id: string;
  readonly name: string;
  getHostname(): string;
  getPort(name: string): import('../hardware/Port').Port | undefined;
  getPorts(): import('../hardware/Port').Port[];
  sendFrame(portName: string, frame: EthernetFrame): void;
  resolveMac?(ip: string): MACAddress | null;
}

const DEDUP_TTL_MS = 30_000;

/** RFC 5176 §3: the NAS-side listener for CoA-Request/Disconnect-Request (default UDP/3799). */
export class CoaListener {
  private running = false;
  private enabled = false;
  private port = UDP_PORT_RADIUS_COA;
  private sharedSecret = '';
  private sessionHandler: CoaSessionHandler | null = null;
  private readonly recentReplies = new Map<string, { response: RadiusPacket; sentAt: number }>();

  constructor(
    private readonly host: CoaListenerHost,
    private readonly getBus: () => IEventBus,
  ) {}

  start(): void { if (!this.running) this.running = true; }
  stop(): void { this.running = false; }

  setEnabled(on: boolean): void { this.enabled = on; }
  setSharedSecret(secret: string): void { this.sharedSecret = secret; }
  setPort(port: number): void { this.port = port; }
  setSessionHandler(handler: CoaSessionHandler | null): void { this.sessionHandler = handler; }

  handleUdp(inPort: string, srcIp: IPAddress, udp: UDPPacket): void {
    if (!this.running || !this.enabled) return;
    if (udp.destinationPort !== this.port) return;
    const payload = udp.payload as RadiusPacket | undefined;
    if (!payload || payload.type !== 'radius') return;
    if (payload.code !== 'disconnect-request' && payload.code !== 'coa-request') return;

    if (!verifyAccountingRequestAuthenticator(payload, this.sharedSecret)) {
      Logger.warn(this.host.id, 'radius:bad-coa-authenticator',
        `${this.host.name}: dropped ${payload.code} from ${srcIp} — invalid Authenticator (shared secret mismatch?)`);
      return;
    }

    const senderIp = srcIp.toString();
    const dedupKey = `coa:${senderIp}:${udp.sourcePort}:${payload.identifier}:${payload.authenticator}`;
    this.pruneDedupCache();
    const cached = this.recentReplies.get(dedupKey);
    if (cached) {
      this.send(inPort, srcIp, udp.sourcePort, cached.response);
      return;
    }

    const ids = readSessionIdentifiers(payload);
    if (!ids.username && !ids.acctSessionId && !ids.callingStationId) {
      this.reply(inPort, srcIp, udp.sourcePort, payload, false, 'missing-attribute', dedupKey);
      return;
    }
    if (!this.sessionHandler) {
      this.reply(inPort, srcIp, udp.sourcePort, payload, false, 'administratively-prohibited', dedupKey);
      return;
    }

    const result = payload.code === 'disconnect-request'
      ? this.sessionHandler.disconnect(ids)
      : this.sessionHandler.reauthorize(ids, payload.attributes);

    this.getBus().publish({
      topic: 'radius.coa.received',
      payload: {
        deviceId: this.host.id, hostname: this.host.getHostname(),
        fromIp: senderIp, code: payload.code,
        username: ids.username, accepted: result.ok,
        errorCause: result.ok === false ? result.errorCause : null,
      },
    });
    Logger.info(this.host.id, 'radius:coa',
      `${this.host.name}: ${payload.code} for ${ids.username ?? ids.acctSessionId ?? '(unidentified)'} → ${result.ok === false ? `nak (${result.errorCause})` : 'ack'}`);

    this.reply(inPort, srcIp, udp.sourcePort, payload, result.ok, result.ok === false ? result.errorCause : null, dedupKey);
  }

  private pruneDedupCache(): void {
    const cutoff = Date.now() - DEDUP_TTL_MS;
    for (const [key, entry] of this.recentReplies) {
      if (entry.sentAt < cutoff) this.recentReplies.delete(key);
    }
  }

  private reply(
    inPort: string, dstIp: IPAddress, clientPort: number, request: RadiusPacket,
    ok: boolean, errorCause: ErrorCause | null, dedupKey: string,
  ): void {
    const isDisconnect = request.code === 'disconnect-request';
    const code = ok
      ? (isDisconnect ? 'disconnect-ack' : 'coa-ack')
      : (isDisconnect ? 'disconnect-nak' : 'coa-nak');
    let response: RadiusPacket = {
      type: 'radius', code, identifier: request.identifier,
      authenticator: '00'.repeat(16),
      attributes: errorCause ? [errorCauseAttr(errorCause)] : [],
    };
    response = withResponseAuthenticator(response, request.authenticator, this.sharedSecret);
    this.recentReplies.set(dedupKey, { response, sentAt: Date.now() });
    this.send(inPort, dstIp, clientPort, response);
  }

  private send(inPort: string, dstIp: IPAddress, clientPort: number, response: RadiusPacket): void {
    const port = this.host.getPort(inPort);
    if (!port) return;
    const srcIp = port.getIPAddress();
    if (!srcIp) return;
    const ipPkt = buildUdpOverIpv4(srcIp, {
      destination: dstIp,
      destinationPort: clientPort, sourcePort: this.port,
      payload: response, payloadBytes: 12,
    });
    const eth: EthernetFrame = {
      srcMAC: port.getMAC(),
      dstMAC: this.host.resolveMac?.(dstIp.toString()) ?? MACAddress.broadcast(),
      etherType: ETHERTYPE_IPV4, payload: ipPkt,
    };
    this.host.sendFrame(inPort, eth);
  }
}

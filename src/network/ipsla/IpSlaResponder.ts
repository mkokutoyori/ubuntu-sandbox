import type { IEventBus } from '@/events/EventBus';
import { ownBusProvider } from '@/events/BusHolder';
import { getDefaultScheduler, type IScheduler } from '@/events/Scheduler';
import { IPAddress, type UDPPacket } from '../core/types';
import { UDP_PORT_IPSLA_CONTROL } from './types';

export interface IpSlaControlRequest {
  type: 'ipsla-control-request';
  operationId: number;
  protocol: 'udp-echo' | 'udp-jitter' | 'tcp-connect';
  port: number;
  durationSeconds: number;
  keyId: number | null;
  digest: string | null;
}

export interface IpSlaControlReply {
  type: 'ipsla-control-reply';
  operationId: number;
  accepted: boolean;
  reason: string;
  clockSynchronized: boolean;
}

export interface IpSlaProbeRequest {
  type: 'ipsla-probe-request';
  operationId: number;
  sequence: number;
  sentAtMs: number;
  payloadSize: number;
  verifyPattern: number | null;
}

export interface IpSlaProbeReply {
  type: 'ipsla-probe-reply';
  operationId: number;
  sequence: number;
  sentAtMs: number;
  receivedAtResponderMs: number;
  transmittedAtResponderMs: number;
  highestSequenceSeen: number;
  receivedSequences: number[];
  clockSynchronized: boolean;
  payloadSize: number;
  verifyPattern: number | null;
}

export type IpSlaWirePayload =
  | IpSlaControlRequest
  | IpSlaControlReply
  | IpSlaProbeRequest
  | IpSlaProbeReply;

export interface ResponderPort {
  port: number;
  protocol: string;
  permanent: boolean;
  expiresAtMs: number | null;
  address: string | null;
  highestSequenceSeen: number;
  receivedSequences: Set<number>;
}

export interface IpSlaResponderHost {
  readonly id: string;
  getHostname(): string;
  sendUdp(destination: IPAddress, sourcePort: number, destinationPort: number, payload: unknown): boolean;
  isClockSynchronized(): boolean;
  resolveKeyDigest(chain: string, keyId: number, material: string): string | null;
}

export class IpSlaResponder {
  private enabled = false;
  private keyChain: string | null = null;
  private readonly ports = new Map<number, ResponderPort>();

  constructor(
    private readonly host: IpSlaResponderHost,
    private readonly getBus: () => IEventBus = ownBusProvider(),
    private readonly getScheduler: () => IScheduler = () => getDefaultScheduler(),
  ) {}

  isEnabled(): boolean { return this.enabled; }
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      for (const entry of [...this.ports.values()]) {
        if (!entry.permanent) this.closePort(entry.port);
      }
    }
  }

  getKeyChain(): string | null { return this.keyChain; }
  setKeyChain(chain: string | null): void { this.keyChain = chain; }

  listPorts(): ResponderPort[] {
    this.expirePorts();
    return [...this.ports.values()].sort((a, b) => a.port - b.port);
  }

  openPermanentPort(protocol: string, port: number, address: string | null): void {
    this.ports.set(port, {
      port, protocol, permanent: true, expiresAtMs: null,
      address, highestSequenceSeen: 0, receivedSequences: new Set(),
    });
    this.publishPort('ipsla.responder.port-opened', port, protocol, true);
  }

  closePermanentPort(port: number): void {
    const entry = this.ports.get(port);
    if (entry?.permanent) this.closePort(port);
  }

  private closePort(port: number): void {
    const entry = this.ports.get(port);
    if (!entry) return;
    this.ports.delete(port);
    this.publishPort('ipsla.responder.port-closed', port, entry.protocol, entry.permanent);
  }

  private publishPort(
    topic: 'ipsla.responder.port-opened' | 'ipsla.responder.port-closed',
    port: number,
    protocol: string,
    permanent: boolean,
  ): void {
    this.getBus().publish({
      topic,
      payload: {
        deviceId: this.host.id,
        hostname: this.host.getHostname(),
        port, protocol, permanent,
      },
    });
  }

  private expirePorts(): void {
    const now = this.getScheduler().now();
    for (const entry of [...this.ports.values()]) {
      if (entry.expiresAtMs !== null && now >= entry.expiresAtMs) this.closePort(entry.port);
    }
  }

  handleUdp(sourceIp: IPAddress, udp: UDPPacket): boolean {
    const payload = udp.payload as IpSlaWirePayload | undefined;
    if (!payload || typeof payload !== 'object' || !('type' in payload)) return false;

    if (udp.destinationPort === UDP_PORT_IPSLA_CONTROL
      && payload.type === 'ipsla-control-request') {
      this.handleControlRequest(sourceIp, udp.sourcePort, payload);
      return true;
    }
    if (payload.type === 'ipsla-probe-request') {
      return this.handleProbeRequest(sourceIp, udp, payload);
    }
    return false;
  }

  private handleControlRequest(
    sourceIp: IPAddress,
    replyPort: number,
    request: IpSlaControlRequest,
  ): void {
    const reject = (reason: string) => {
      this.host.sendUdp(sourceIp, UDP_PORT_IPSLA_CONTROL, replyPort, {
        type: 'ipsla-control-reply',
        operationId: request.operationId,
        accepted: false,
        reason,
        clockSynchronized: this.host.isClockSynchronized(),
      } satisfies IpSlaControlReply);
    };

    if (!this.enabled) return;
    if (this.keyChain !== null) {
      if (request.keyId === null || request.digest === null) {
        reject('authentication required');
        return;
      }
      const expected = this.host.resolveKeyDigest(
        this.keyChain, request.keyId, controlDigestMaterial(request),
      );
      if (expected === null || expected !== request.digest) {
        reject('authentication failure');
        return;
      }
    }
    this.expirePorts();
    const existing = this.ports.get(request.port);
    if (existing && existing.permanent) {
      reject(`port ${request.port} statically bound`);
      return;
    }
    const now = this.getScheduler().now();
    this.ports.set(request.port, {
      port: request.port,
      protocol: request.protocol,
      permanent: false,
      expiresAtMs: now + Math.max(1, request.durationSeconds) * 1000,
      address: sourceIp.toString(),
      highestSequenceSeen: 0,
      receivedSequences: new Set(),
    });
    this.publishPort('ipsla.responder.port-opened', request.port, request.protocol, false);
    this.host.sendUdp(sourceIp, UDP_PORT_IPSLA_CONTROL, replyPort, {
      type: 'ipsla-control-reply',
      operationId: request.operationId,
      accepted: true,
      reason: '',
      clockSynchronized: this.host.isClockSynchronized(),
    } satisfies IpSlaControlReply);
  }

  private handleProbeRequest(
    sourceIp: IPAddress,
    udp: UDPPacket,
    request: IpSlaProbeRequest,
  ): boolean {
    this.expirePorts();
    const entry = this.ports.get(udp.destinationPort);
    if (!entry) return false;
    const receivedAt = this.getScheduler().now();
    if (request.sequence > entry.highestSequenceSeen) {
      entry.highestSequenceSeen = request.sequence;
    }
    entry.receivedSequences.add(request.sequence);
    const reply: IpSlaProbeReply = {
      type: 'ipsla-probe-reply',
      operationId: request.operationId,
      sequence: request.sequence,
      sentAtMs: request.sentAtMs,
      receivedAtResponderMs: receivedAt,
      transmittedAtResponderMs: this.getScheduler().now(),
      highestSequenceSeen: entry.highestSequenceSeen,
      receivedSequences: [...entry.receivedSequences],
      clockSynchronized: this.host.isClockSynchronized(),
      payloadSize: request.payloadSize,
      verifyPattern: request.verifyPattern,
    };
    this.host.sendUdp(sourceIp, udp.destinationPort, udp.sourcePort, reply);
    return true;
  }

  reset(): void {
    this.enabled = false;
    this.keyChain = null;
    this.ports.clear();
  }
}

export function controlDigestMaterial(request: IpSlaControlRequest): string {
  return `${request.operationId}|${request.protocol}|${request.port}|${request.durationSeconds}`;
}

import { IP_PROTO_ICMP, type ICMPPacket, type IPv4Packet } from '../../../core/types';
import {
  DEAD_LOSS_PERCENT,
  type SdwanHealthCheck, type SdwanHealthTransition,
  type SdwanMember, type SdwanTable,
} from './SdwanTable';
import { buildEchoRequest } from '../../../icmp/IcmpEcho';

export interface ProbeDeps {
  readonly send: (iface: string, packet: IPv4Packet, gateway: string) => void;
  readonly localIp: (iface: string) => string | undefined;
  readonly settle: () => Promise<void>;
  readonly dial?: (iface: string, server: string, port: number, request?: string) => Promise<DialResult>;
}

export interface DialResult {
  readonly connected: boolean;
  readonly response?: string;
}

export interface EchoSample {
  readonly identifier: number;
  readonly sequence: number;
  answered: boolean;
}

export class SdwanHealthProbe {
  private readonly pending = new Map<string, EchoSample>();
  private nextIdentifier = 1;

  constructor(private readonly deps: ProbeDeps) {}

  async run(table: SdwanTable): Promise<readonly SdwanHealthTransition[]> {
    const changes: SdwanHealthTransition[] = [];
    for (const check of table.allHealthChecks()) {
      for (const sequence of check.members) {
        const member = table.member(sequence);
        if (!member) continue;
        const change = table.recordHealth(
          check.name, sequence, await this.measure(check, member));
        if (change) changes.push(change);
      }
    }
    return changes;
  }

  observeReply(packet: IPv4Packet): boolean {
    if (packet.protocol !== IP_PROTO_ICMP) return false;

    const icmp = packet.payload as ICMPPacket | undefined;
    if (icmp?.type !== 'icmp' || icmp.icmpType !== 'echo-reply') return false;

    const sample = this.pending.get(keyOf(icmp.id, icmp.sequence));
    if (!sample) return false;

    sample.answered = true;
    return true;
  }

  private async measure(
    check: SdwanHealthCheck, member: SdwanMember,
  ): Promise<{ alive: boolean; packetLossPercent: number; latencyMs: number; jitterMs: number }> {
    const source = this.deps.localIp(member.iface);
    if (source === undefined) {
      return { alive: false, packetLossPercent: DEAD_LOSS_PERCENT, latencyMs: 0, jitterMs: 0 };
    }

    let last = { alive: false, packetLossPercent: DEAD_LOSS_PERCENT, latencyMs: 0, jitterMs: 0 };
    for (const server of check.servers) {
      last = await this.probeServer(check, member, source, server);
      if (last.alive) return last;
    }
    return last;
  }

  private async probeServer(
    check: SdwanHealthCheck, member: SdwanMember, source: string, server: string,
  ): Promise<{ alive: boolean; packetLossPercent: number; latencyMs: number; jitterMs: number }> {
    if (check.protocol === 'tcp-connect' || check.protocol === 'http') {
      return this.probeOverTcp(check, member, server);
    }
    const identifier = this.nextIdentifier++;
    const samples: EchoSample[] = [];

    for (let sequence = 1; sequence <= check.probeCount; sequence++) {
      const sample: EchoSample = { identifier, sequence, answered: false };
      samples.push(sample);
      this.pending.set(keyOf(identifier, sequence), sample);
      this.deps.send(
        member.iface, buildEchoRequest(source, server, identifier, sequence), member.gateway);
    }

    await this.deps.settle();
    for (const sample of samples) this.pending.delete(keyOf(sample.identifier, sample.sequence));

    const answered = samples.filter(sample => sample.answered).length;
    const loss = ((samples.length - answered) / samples.length) * 100;
    return {
      alive: answered > 0,
      packetLossPercent: loss,
      latencyMs: 0,
      jitterMs: 0,
    };
  }

  private async probeOverTcp(
    check: SdwanHealthCheck, member: SdwanMember, server: string,
  ): Promise<{ alive: boolean; packetLossPercent: number; latencyMs: number; jitterMs: number }> {
    const port = check.port > 0 ? check.port : HTTP_DEFAULT_PORT;
    const request = check.protocol === 'http'
      ? `GET ${check.httpGet ?? '/'} HTTP/1.1\r\nHost: ${server}\r\nConnection: close\r\n\r\n`
      : undefined;
    let answered = 0;
    for (let attempt = 0; attempt < check.probeCount; attempt++) {
      const result = this.deps.dial === undefined
        ? { connected: false } as DialResult
        : await this.deps.dial(member.iface, server, port, request);
      if (result.connected && (request === undefined || httpStatusAccepted(result.response))) answered++;
    }
    const loss = ((check.probeCount - answered) / check.probeCount) * 100;
    return { alive: answered > 0, packetLossPercent: loss, latencyMs: 0, jitterMs: 0 };
  }
}

const HTTP_DEFAULT_PORT = 80;

function httpStatusAccepted(response: string | undefined): boolean {
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(response ?? '')?.[1];
  return status !== undefined && Number(status) < 400;
}

function keyOf(identifier: number, sequence: number): string {
  return `${identifier}:${sequence}`;
}

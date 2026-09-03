import { IPv6Address } from '../../../core/types';
import type { IPv6DataPlane } from '../../router/IPv6DataPlane';
import { ECHO_DATA_BYTES } from '../../../icmp/IcmpEcho';
import { PING_NO_ROUTE, type PingRun } from './FirewallPing';
import type { PingOptions } from './PingOptions';

export interface Ipv6EchoReply {
  readonly fromIp: string;
  readonly toIp: string;
  readonly id: number;
  readonly seq: number;
  readonly hopLimit: number;
}

interface Awaited6 { answered: boolean; hopLimit: number }

export class FirewallPing6 {
  private readonly pending = new Map<string, Awaited6>();
  private nextIdentifier = 1;

  constructor(
    private readonly engine: () => IPv6DataPlane,
    private readonly options?: () => PingOptions,
  ) {}

  private settings(): { repeatCount: number; dataSize: number } {
    const current = this.options?.().current();
    return {
      repeatCount: current?.repeatCount ?? 5,
      dataSize: current?.dataSize ?? ECHO_DATA_BYTES,
    };
  }

  observeReply(reply: Ipv6EchoReply): void {
    const waiting = this.pending.get(`${reply.id}:${reply.seq}`);
    if (!waiting) return;
    waiting.answered = true;
    waiting.hopLimit = reply.hopLimit;
  }

  begin(target: string): PingRun | null {
    let destination: IPv6Address;
    try {
      destination = new IPv6Address(target);
    } catch {
      return null;
    }
    const egress = this.engine().resolveEgress(destination);
    if (!egress) return null;

    const identifier = this.nextIdentifier++;
    const answered: Awaited6[] = [];
    const { dataSize } = this.settings();

    return {
      header: `PING ${target} (${target}): ${dataSize} data bytes`,
      step: (sequence: number) => {
        const waiting: Awaited6 = { answered: false, hopLimit: 0 };
        answered.push(waiting);
        const key = `${identifier}:${sequence}`;
        this.pending.set(key, waiting);
        this.engine().sendEchoRequest(
          egress, destination, identifier, sequence, dataSize);
        this.pending.delete(key);
        if (!waiting.answered) return null;
        return `${dataSize + 8} bytes from ${target}: `
          + `icmp_seq=${sequence} ttl=${waiting.hopLimit} time=0.0 ms`;
      },
      statistics: (sent: number) => {
        const received = answered.filter(a => a.answered).length;
        const lines = [
          '',
          `--- ${target} ping statistics ---`,
          `${sent} packets transmitted, ${received} packets received, `
            + `${sent === 0 ? 0 : Math.round(((sent - received) / sent) * 100)}% packet loss`,
        ];
        if (received > 0) lines.push('round-trip min/avg/max = 0.0/0.0/0.0 ms');
        return lines.join('\n');
      },
    };
  }

  run(target: string, count = this.settings().repeatCount): string {
    const session = this.begin(target);
    if (!session) return PING_NO_ROUTE;

    const lines = [session.header];
    for (let sequence = 0; sequence < count; sequence++) {
      const line = session.step(sequence);
      if (line !== null) lines.push(line);
    }
    lines.push(session.statistics(count));
    return lines.join('\n');
  }
}

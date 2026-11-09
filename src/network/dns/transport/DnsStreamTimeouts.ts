import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import { EDNS_OPTION_TCP_KEEPALIVE, hasEdnsOption, tcpKeepaliveOption, withEdnsOption } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsStreamReply } from '@/network/dns/transport/DnsTcpTransport';

export interface DnsStreamTimeouts {
  readonly firstRequestMs: number;
  readonly idleMs: number;
  readonly keepaliveMs: number;
  readonly advertisedUnits: number | null;
}

export const DNS_TCP_IDLE_TIMEOUT_MS = 10000;

export const LEGACY_STREAM_TIMEOUTS: DnsStreamTimeouts = {
  firstRequestMs: DNS_TCP_IDLE_TIMEOUT_MS,
  idleMs: DNS_TCP_IDLE_TIMEOUT_MS,
  keepaliveMs: DNS_TCP_IDLE_TIMEOUT_MS,
  advertisedUnits: null,
};

const TENTH_OF_SECOND_MS = 100;

export const timeoutsFromTenths = (
  tenths: { readonly initial: number; readonly idle: number; readonly keepalive: number; readonly advertised: number },
  transport: 'tcp' | 'tls',
): DnsStreamTimeouts => ({
  firstRequestMs: (transport === 'tcp' ? tenths.initial : tenths.idle) * TENTH_OF_SECOND_MS,
  idleMs: tenths.idle * TENTH_OF_SECOND_MS,
  keepaliveMs: tenths.keepalive * TENTH_OF_SECOND_MS,
  advertisedUnits: tenths.advertised,
});

export class DnsStreamLifetime {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private keepalive = false;

  constructor(private readonly close: () => void, private readonly timeouts: DnsStreamTimeouts) {
    this.arm(timeouts.firstRequestMs);
  }

  activity(): void {
    this.arm(this.currentMs());
  }

  requested(query: DnsMessage): void {
    if (hasEdnsOption(query, EDNS_OPTION_TCP_KEEPALIVE)) this.keepalive = true;
    this.arm(this.currentMs());
  }

  answered(query: DnsMessage, reply: DnsStreamReply): DnsStreamReply {
    if (this.timeouts.advertisedUnits === null || reply === null || Array.isArray(reply)) return reply;
    if (!hasEdnsOption(query, EDNS_OPTION_TCP_KEEPALIVE)) return reply;
    return withEdnsOption(reply as DnsMessage, tcpKeepaliveOption(this.timeouts.advertisedUnits));
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private currentMs(): number {
    return this.keepalive ? this.timeouts.keepaliveMs : this.timeouts.idleMs;
  }

  private arm(ms: number): void {
    this.stop();
    this.timer = setTimeout(this.close, ms);
  }
}

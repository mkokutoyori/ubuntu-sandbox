import type { RateVerdict } from '@/network/dns/rrl/ResponseRateLimiter';

export const DNS_ANALYTICAL_LOG = 'Microsoft-Windows-DNSServer/Analytical';

export const DNS_SERVER_EVENT_SOURCE = 'Microsoft-Windows-DNSServer';

export interface DnsAnalyticEvent {
  readonly id: number;
  readonly name: string;
  readonly fields: Readonly<Record<string, string>>;
}

export type DnsAnalyticSink = (event: DnsAnalyticEvent) => void;

export const RATE_ANALYTIC_EVENTS: Readonly<Record<Exclude<RateVerdict, 'send'>, { readonly id: number; readonly name: string }>> = {
  drop: { id: 281, name: 'RRL_TO_BE_DROPPED_RESPONSE' },
  truncate: { id: 282, name: 'RRL_TO_BE_TRUNCATED_RESPONSE' },
  leak: { id: 283, name: 'RRL_TO_BE_LEAKED_RESPONSE' },
};

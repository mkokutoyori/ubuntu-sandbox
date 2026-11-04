import type { DnsMessage } from '@/network/dns/wire/DnsMessage';

export type FailureReason = 'timed out' | 'connection refused' | 'network unreachable' | 'host unreachable';

export interface ExchangeFailure {
  readonly outcome: 'failed';
  readonly phase: 'setup' | 'exchange';
  readonly reason: FailureReason;
}

export interface ExchangeReply {
  readonly outcome: 'reply';
  readonly message: DnsMessage;
  readonly size: number;
  readonly elapsedMs: number;
}

export type ExchangeOutcome = ExchangeReply | ExchangeFailure;

export interface ExchangeRequest {
  readonly address: string;
  readonly port: number;
  readonly name: string;
  readonly type: number;
  readonly rrClass: number;
  readonly recurse: boolean;
  readonly tcp: boolean;
  readonly timeoutMs: number;
}

export interface TransferRequest {
  readonly address: string;
  readonly port: number;
  readonly name: string;
  readonly type: number;
  readonly rrClass: number;
  readonly ixfrSerial: number;
  readonly timeoutMs: number;
}

export interface TransferReply {
  readonly outcome: 'messages';
  readonly messages: readonly DnsMessage[];
  readonly sizes: readonly number[];
  readonly elapsedMs: number;
}

export type TransferOutcome = TransferReply | ExchangeFailure;

export interface HostPort {
  resolvConf(): string | null;
  ipv6Available(): boolean;
  addressesOf(name: string): Promise<readonly string[] | null>;
  exchange(request: ExchangeRequest): Promise<ExchangeOutcome>;
  transfer(request: TransferRequest): Promise<TransferOutcome>;
}

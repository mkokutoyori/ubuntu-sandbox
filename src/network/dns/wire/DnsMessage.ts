import type { DnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import type { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

/** RFC 1035 §4.1.2: a single entry of the Question section. */
export interface DnsQuestion {
  readonly qname: string;
  readonly qtype: RRType | number;
  readonly qclass: DnsClass | number;
}

/**
 * A fully-parsed DNS message (RFC 1035 §4). Section counts (QDCOUNT,
 * ANCOUNT, NSCOUNT, ARCOUNT) are derived from array lengths rather than
 * stored redundantly — the codec is the only place that needs the raw
 * wire-format counts.
 */
export interface DnsMessage {
  readonly id: number;
  readonly flags: DnsHeaderFlags;
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly authorities: readonly ResourceRecord<ResourceRecordData>[];
  readonly additionals: readonly ResourceRecord<ResourceRecordData>[];
}

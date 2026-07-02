import type { DnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import type { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';

export interface DnsQuestion {
  readonly qname: string;
  readonly qtype: RRType | number;
  readonly qclass: DnsClass | number;
}

export interface DnsMessage {
  readonly id: number;
  readonly flags: DnsHeaderFlags;
  readonly questions: readonly DnsQuestion[];
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly authorities: readonly ResourceRecord<ResourceRecordData>[];
  readonly additionals: readonly ResourceRecord<ResourceRecordData>[];
}

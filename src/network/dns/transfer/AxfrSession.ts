import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { Zone, ZoneError } from '@/network/dns/zone/Zone';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData, SoaRecordData } from '@/network/dns/wire/ResourceRecord';

export function isTransferQuery(message: DnsMessage): boolean {
  const qtype = message.questions[0]?.qtype;
  return qtype === RRType.AXFR || qtype === RRType.IXFR;
}

export function buildAxfrAnswers(zone: Zone): ResourceRecord<ResourceRecordData>[] {
  const soa = zone.soa as ResourceRecord<ResourceRecordData>;
  const body = zone.allRecords().filter((rr) => rr.data.type !== RRType.SOA);
  return [soa, ...body, soa];
}

export function buildTransferResponse(
  query: DnsMessage, answers: readonly ResourceRecord<ResourceRecordData>[],
): DnsMessage {
  return {
    id: query.id,
    flags: {
      qr: true, opcode: DnsOpcode.QUERY, aa: true, tc: false,
      rd: query.flags.rd, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
    },
    questions: query.questions,
    answers,
    authorities: [],
    additionals: [],
  };
}

export function refuseTransfer(query: DnsMessage): DnsMessage {
  return {
    id: query.id,
    flags: {
      qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: query.flags.rd, ra: false, ad: false, cd: false, rcode: DnsRcode.REFUSED,
    },
    questions: query.questions,
    answers: [],
    authorities: [],
    additionals: [],
  };
}

export function zoneFromTransferAnswers(
  origin: string, answers: readonly ResourceRecord<ResourceRecordData>[],
): Zone {
  const head = answers[0];
  if (!head || head.data.type !== RRType.SOA) {
    throw new ZoneError('a full zone transfer must start with the zone SOA');
  }
  const zone = new Zone(origin, head as ResourceRecord<SoaRecordData>);
  for (const rr of answers.slice(1, -1)) {
    if (rr.data.type === RRType.SOA) continue;
    zone.addRecord(rr);
  }
  return zone;
}

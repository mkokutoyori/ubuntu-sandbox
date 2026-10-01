import { encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
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

export const TRANSFER_MESSAGE_BUDGET = 16384;

export function buildTransferMessages(
  query: DnsMessage, answers: readonly ResourceRecord<ResourceRecordData>[],
): DnsMessage[] {
  const empty = buildTransferResponse(query, []);
  const base = encodeDnsMessage(empty).length;
  const messages: DnsMessage[] = [];
  let batch: ResourceRecord<ResourceRecordData>[] = [];
  let size = base;
  for (const rr of answers) {
    const cost = encodeDnsMessage({ ...empty, answers: [rr] }).length - base;
    if (batch.length >= 2 && size + cost > TRANSFER_MESSAGE_BUDGET) {
      messages.push(buildTransferResponse(query, batch));
      batch = [];
      size = base;
    }
    batch.push(rr);
    size += cost;
  }
  messages.push(buildTransferResponse(query, batch));
  return messages;
}

export function transferComplete(messages: readonly DnsMessage[]): boolean {
  const first = messages[0];
  if (!first) return false;
  if (first.flags.rcode !== DnsRcode.NOERROR) return true;
  const answers = messages.flatMap((message) => message.answers);
  const head = answers[0];
  if (!head || head.data.type !== RRType.SOA) return true;
  if (answers.length === 1 && messages.length === 1) return true;
  const last = answers[answers.length - 1];
  return answers.length > 1 && last.data.type === RRType.SOA
    && (last.data as SoaRecordData).serial === (head.data as SoaRecordData).serial;
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

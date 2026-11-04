import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { echoedOpt, findOpt, makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import { normalizeDnsName } from '@/network/dns/wire/DnsName';
import { additionalSectionTarget } from '@/network/dns/wire/AdditionalTarget';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { NsRecordData, ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import type { DnsCache } from '@/network/dns/resolver/DnsCache';
import type { ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';
import type { PositiveTrim } from '@/network/dns/zone/ZoneStore';

export interface RecursiveEnvelope {
  readonly cache: DnsCache;
  readonly trim: PositiveTrim;
  readonly ednsPayloadSize: number;
}

const SIGNING_TYPES: ReadonlySet<number> = new Set([RRType.RRSIG, RRType.NSEC]);

function queryType(query: DnsMessage): number {
  return query.questions[0].qtype;
}

function answersNothing(answers: DnsMessage['answers'], qtype: number): boolean {
  return qtype === RRType.CNAME ? answers.length === 0 : answers.every((rr) => rr.data.type === RRType.CNAME);
}

function negativeAuthorities(result: ResolutionResult, negative: boolean, wantsDnssec: boolean): DnsMessage['authorities'] {
  if (!negative) return [];
  return (result.authorities ?? []).filter((rr) => rr.data.type === RRType.SOA || (wantsDnssec && SIGNING_TYPES.has(rr.data.type)));
}

export function recursiveResolveOptions(query: DnsMessage): { checkingDisabled: boolean } {
  return { checkingDisabled: query.flags.cd };
}

function positiveEnvelope(
  answers: DnsMessage['answers'], envelope: RecursiveEnvelope, qtype: number,
): { authority: readonly ResourceRecord<NsRecordData>[]; additional: ResourceRecord<ResourceRecordData>[] } {
  const nameServerAnswers = answers.filter((rr) => rr.data.type === RRType.NS);
  const authority = envelope.trim === 'none' && nameServerAnswers.length === 0
    ? envelope.cache.enclosingNameServers(answers[answers.length - 1].name)
    : [];
  const sources = qtype === RRType.ANY ? [] : envelope.trim === 'authority-and-additional' ? nameServerAnswers : [...answers, ...authority];
  const answered = new Set(answers.map((rr) => normalizeDnsName(rr.name)));
  const additional: ResourceRecord<ResourceRecordData>[] = [];
  for (const source of sources) {
    const target = additionalSectionTarget(source);
    if (target === null) continue;
    const key = normalizeDnsName(target);
    if (answered.has(key)) continue;
    answered.add(key);
    additional.push(...envelope.cache.knownAddresses(target));
  }
  return { authority, additional };
}

export function buildRecursiveResponse(query: DnsMessage, result: ResolutionResult, envelope?: RecursiveEnvelope): DnsMessage {
  const wantsDnssec = findOpt(query)?.data.dnssecOk === true;
  const authenticated = result.security === 'secure' && (wantsDnssec || query.flags.ad);
  const answers = wantsDnssec
    ? [...result.answers]
    : result.answers.filter((rr) => rr.data.type !== RRType.RRSIG && rr.data.type !== RRType.NSEC);
  const rcode =
    result.status === 'NOERROR' ? DnsRcode.NOERROR :
    result.status === 'NXDOMAIN' ? DnsRcode.NXDOMAIN :
    DnsRcode.SERVFAIL;
  const negative = answersNothing(answers, queryType(query)) && result.status !== 'SERVFAIL';
  const positive = !negative && result.status === 'NOERROR' && answers.length > 0;
  const carried = envelope !== undefined && positive ? positiveEnvelope(answers, envelope, queryType(query)) : null;
  const opt = envelope !== undefined
    ? echoedOpt(query, envelope.ednsPayloadSize)
    : wantsDnssec ? [makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE, { dnssecOk: true })] : [];
  return {
    id: query.id,
    flags: {
      qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: query.flags.rd, ra: true, ad: authenticated, cd: query.flags.cd, rcode,
    },
    questions: [query.questions[0]],
    answers,
    authorities: carried !== null ? [...carried.authority] : negativeAuthorities(result, negative, wantsDnssec),
    additionals: [...(carried?.additional ?? []), ...opt],
  };
}

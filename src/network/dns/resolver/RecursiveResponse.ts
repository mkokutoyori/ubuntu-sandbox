import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { findOpt, makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';

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

export function buildRecursiveResponse(query: DnsMessage, result: ResolutionResult): DnsMessage {
  const wantsDnssec = findOpt(query)?.data.dnssecOk === true;
  const authenticated = result.security === 'secure' && (wantsDnssec || query.flags.ad);
  const answers = wantsDnssec
    ? [...result.answers]
    : result.answers.filter((rr) => rr.data.type !== RRType.RRSIG && rr.data.type !== RRType.NSEC);
  const rcode =
    result.status === 'NOERROR' ? DnsRcode.NOERROR :
    result.status === 'NXDOMAIN' ? DnsRcode.NXDOMAIN :
    DnsRcode.SERVFAIL;
  return {
    id: query.id,
    flags: {
      qr: true, opcode: DnsOpcode.QUERY, aa: false, tc: false,
      rd: query.flags.rd, ra: true, ad: authenticated, cd: query.flags.cd, rcode,
    },
    questions: [query.questions[0]],
    answers,
    authorities: negativeAuthorities(result, answersNothing(answers, queryType(query)) && result.status !== 'SERVFAIL', wantsDnssec),
    additionals: wantsDnssec ? [makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE, { dnssecOk: true })] : [],
  };
}

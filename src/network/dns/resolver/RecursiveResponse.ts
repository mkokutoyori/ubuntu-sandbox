import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { findOpt, makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResolutionResult } from '@/network/dns/resolver/RecursiveResolver';

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
    authorities: [],
    additionals: wantsDnssec ? [makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE, { dnssecOk: true })] : [],
  };
}

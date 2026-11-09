import { decodeDnsMessage, encodeDnsMessage } from '@/network/dns/wire/DnsMessageCodec';
import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import { makeAaaaRecord, makeARecord, type ResourceRecord } from '@/network/dns/wire/ResourceRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { DnsFilterProfile } from './UtmProfiles';

const SINKHOLE_TTL_SECONDS = 60;
const UNSPECIFIED_V4 = '0.0.0.0';

function answersFor(query: DnsMessage, profile: DnsFilterProfile): ResourceRecord[] | undefined {
  const question = query.questions[0];
  if (profile.redirectPortal === undefined || profile.redirectPortal === UNSPECIFIED_V4) return undefined;
  if (question.qtype === RRType.A) return [makeARecord(question.qname, SINKHOLE_TTL_SECONDS, profile.redirectPortal)];
  if (question.qtype === RRType.AAAA && profile.redirectPortal6 !== undefined) {
    return [makeAaaaRecord(question.qname, SINKHOLE_TTL_SECONDS, profile.redirectPortal6)];
  }
  return [];
}

export function blockedDnsReply(queryBytes: Uint8Array, profile: DnsFilterProfile): Uint8Array | undefined {
  let query: DnsMessage;
  try {
    query = decodeDnsMessage(queryBytes);
  } catch {
    return undefined;
  }
  if (query.flags.qr || query.questions.length === 0) return undefined;

  let rcode: number = DnsRcode.NOERROR;
  let answers: ResourceRecord[] = [];
  if (profile.blockAction === 'block') rcode = DnsRcode.NXDOMAIN;
  else if (profile.blockAction === 'block-sevrfail') rcode = DnsRcode.SERVFAIL;
  else {
    const redirected = answersFor(query, profile);
    if (redirected === undefined) return undefined;
    answers = redirected;
  }

  return encodeDnsMessage({
    id: query.id,
    flags: { ...query.flags, qr: true, aa: false, tc: false, ra: true, ad: false, cd: false, rcode },
    questions: query.questions,
    answers,
    authorities: [],
    additionals: [],
  });
}

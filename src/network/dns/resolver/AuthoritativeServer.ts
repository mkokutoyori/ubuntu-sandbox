import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ZoneStore } from '@/network/dns/zone/ZoneStore';

type BaseFlags = Pick<DnsHeaderFlags, 'qr' | 'rd' | 'ra' | 'ad' | 'cd'>;

/**
 * Answers DNS queries authoritatively from a {@link ZoneStore} (RFC 1035
 * §4.2, §6): AA=1 for names covered by a hosted zone, non-authoritative
 * referrals/NXDOMAIN/NODATA exactly as produced by zone lookup. Never sets
 * TC — truncation for the 512-octet classic UDP limit is a transport-layer
 * concern (see `transport/DnsUdpTransport.ts`), not something the engine
 * that builds the logical answer should decide.
 */
export class AuthoritativeServer {
  constructor(private readonly zones: ZoneStore) {}

  answer(query: DnsMessage): DnsMessage {
    const baseFlags: BaseFlags = { qr: true, rd: query.flags.rd, ra: false, ad: false, cd: false };

    if (query.flags.opcode !== DnsOpcode.QUERY) {
      return this.errorResponse(query, baseFlags, DnsRcode.NOTIMP);
    }
    if (query.questions.length !== 1) {
      return this.errorResponse(query, baseFlags, DnsRcode.FORMERR);
    }

    const question = query.questions[0];
    const result = this.zones.answer(question);

    return {
      id: query.id,
      flags: { ...baseFlags, opcode: DnsOpcode.QUERY, aa: result.aa, tc: false, rcode: result.rcode },
      questions: [question],
      answers: result.answers,
      authorities: result.authority,
      additionals: result.additional,
    };
  }

  private errorResponse(query: DnsMessage, baseFlags: BaseFlags, rcode: number): DnsMessage {
    return {
      id: query.id,
      flags: { ...baseFlags, opcode: query.flags.opcode, aa: false, tc: false, rcode },
      questions: query.questions,
      answers: [],
      authorities: [],
      additionals: [],
    };
  }
}

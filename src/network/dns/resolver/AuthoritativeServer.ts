import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import {
  findOpt, makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE, EDNS_VERSION, EDNS_BADVERS_EXTENDED_RCODE_HIGH,
} from '@/network/dns/wire/EdnsOptRecord';
import type { ZoneStore } from '@/network/dns/zone/ZoneStore';

type BaseFlags = Pick<DnsHeaderFlags, 'qr' | 'rd' | 'ra' | 'ad' | 'cd'>;

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

    const queryOpt = findOpt(query);
    if (queryOpt && queryOpt.data.version > EDNS_VERSION) {
      return {
        id: query.id,
        flags: { ...baseFlags, opcode: DnsOpcode.QUERY, aa: false, tc: false, rcode: DnsRcode.NOERROR },
        questions: query.questions,
        answers: [],
        authorities: [],
        additionals: [makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE, {
          extendedRcodeHigh: EDNS_BADVERS_EXTENDED_RCODE_HIGH,
        })],
      };
    }

    const question = query.questions[0];
    const result = this.zones.answer(question);
    const additionals: ResourceRecord<ResourceRecordData>[] = [...result.additional];
    if (queryOpt) {
      additionals.push(makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE));
    }

    return {
      id: query.id,
      flags: { ...baseFlags, opcode: DnsOpcode.QUERY, aa: result.aa, tc: false, rcode: result.rcode },
      questions: [question],
      answers: result.answers,
      authorities: result.authority,
      additionals,
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

import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsHeaderFlags } from '@/network/dns/wire/DnsHeaderFlags';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { ResourceRecord, ResourceRecordData } from '@/network/dns/wire/ResourceRecord';
import {
  findOpt, findOpts, makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE, EDNS_VERSION, EDNS_BADVERS_EXTENDED_RCODE_HIGH,
} from '@/network/dns/wire/EdnsOptRecord';
import type { PositiveTrim, ZoneStore } from '@/network/dns/zone/ZoneStore';
import type { Zone } from '@/network/dns/zone/Zone';

type BaseFlags = Pick<DnsHeaderFlags, 'qr' | 'rd' | 'ra' | 'ad' | 'cd'>;

export interface AuthoritativePolicy {
  readonly blocks?: (zoneOrigin: string, qname: string) => boolean;
  readonly acceptsEdns?: () => boolean;
  readonly rotates?: () => boolean;
  readonly writesApexNs?: () => boolean;
  readonly trimsPositiveAnswers?: (recursionDesired: boolean) => PositiveTrim;
  readonly ednsPayloadSize?: () => number;
  readonly recursionAvailable?: () => boolean;
}

export interface AuthoritativeResponse {
  readonly message: DnsMessage;
  readonly imputedName: string;
}

export class AuthoritativeServer {
  constructor(private readonly zones: ZoneStore, private readonly policy: AuthoritativePolicy = {}) {}

  answer(query: DnsMessage): DnsMessage {
    return this.respond(query).message;
  }

  refuse(query: DnsMessage): DnsMessage {
    return this.errorResponse(query, this.baseFlags(query), DnsRcode.REFUSED);
  }

  respond(query: DnsMessage, records?: Zone): AuthoritativeResponse {
    const baseFlags = this.baseFlags(query);

    if (query.flags.opcode !== DnsOpcode.QUERY) {
      return this.unplaced(this.errorResponse(query, baseFlags, DnsRcode.NOTIMP));
    }
    if (query.questions.length !== 1) {
      return this.unplaced(this.errorResponse(query, baseFlags, DnsRcode.FORMERR));
    }

    const opts = findOpts(query);
    if (opts.length > 1 || opts.some((opt) => opt.name !== '')) {
      return this.unplaced(this.errorResponse(query, baseFlags, DnsRcode.FORMERR));
    }
    if (opts.length > 0 && this.policy.acceptsEdns?.() === false) {
      return this.unplaced(this.errorResponse(query, baseFlags, DnsRcode.FORMERR));
    }
    const queryOpt = findOpt(query);
    if (queryOpt && queryOpt.data.version > EDNS_VERSION) {
      return this.unplaced({
        id: query.id,
        flags: { ...baseFlags, opcode: DnsOpcode.QUERY, aa: false, tc: false, rcode: DnsRcode.NOERROR },
        questions: query.questions,
        answers: [],
        authorities: [],
        additionals: [makeOptRecord(this.advertisedPayloadSize(), {
          extendedRcodeHigh: EDNS_BADVERS_EXTENDED_RCODE_HIGH,
        })],
      });
    }

    const question = query.questions[0];
    const wantDnssec = queryOpt?.data.dnssecOk === true;
    const result = this.zones.answer(question, {
      dnssec: wantDnssec,
      blocked: this.policy.blocks,
      rotate: this.policy.rotates?.(),
      apexNs: this.policy.writesApexNs?.(),
      trim: this.policy.trimsPositiveAnswers?.(query.flags.rd),
      zone: records,
    });
    const additionals: ResourceRecord<ResourceRecordData>[] = [...result.additional];
    if (queryOpt) {
      additionals.push(makeOptRecord(this.advertisedPayloadSize(), { dnssecOk: wantDnssec }));
    }

    return {
      message: {
        id: query.id,
        flags: { ...baseFlags, opcode: DnsOpcode.QUERY, aa: result.aa, tc: false, rcode: result.rcode },
        questions: [question],
        answers: result.answers,
        authorities: result.authority,
        additionals,
      },
      imputedName: result.imputedName,
    };
  }

  private advertisedPayloadSize(): number {
    return this.policy.ednsPayloadSize?.() ?? DEFAULT_EDNS_PAYLOAD_SIZE;
  }

  private baseFlags(query: DnsMessage): BaseFlags {
    return { qr: true, rd: query.flags.rd, ra: this.policy.recursionAvailable?.() ?? false, ad: false, cd: false };
  }

  private unplaced(message: DnsMessage): AuthoritativeResponse {
    return { message, imputedName: '' };
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

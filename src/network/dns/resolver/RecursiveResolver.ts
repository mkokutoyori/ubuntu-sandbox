import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import { makeOptRecord, DEFAULT_EDNS_PAYLOAD_SIZE } from '@/network/dns/wire/EdnsOptRecord';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type {
  ResourceRecord, ResourceRecordData, SoaRecordData, NsRecordData, ARecordData, CnameRecordData, DsRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { queryAuthoritativeServer } from '@/network/dns/transport/DnsTcpTransport';
import { DnsCache } from '@/network/dns/resolver/DnsCache';
import { DnsValidator } from '@/network/dns/dnssec/DnsValidator';
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';

export type ResolutionStatus = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';

export interface ResolutionResult {
  readonly status: ResolutionStatus;
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly fromCache: boolean;
  readonly security?: DnssecStatus;
}

export interface RecursiveResolverDnssecOptions {
  readonly anchors: readonly ResourceRecord<DsRecordData>[];
  readonly now?: () => number;
}

export interface RecursiveResolverOptions {
  readonly timeoutMs?: number;
  readonly maxReferrals?: number;
  readonly maxDepth?: number;
  readonly dnssec?: RecursiveResolverDnssecOptions;
}

interface IterationOutcome {
  readonly status: ResolutionStatus;
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly authorities: readonly ResourceRecord<ResourceRecordData>[];
  readonly negative: 'nxdomain' | 'nodata' | null;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_REFERRALS = 16;
const DEFAULT_MAX_DEPTH = 8;
const QUERY_ID_SPACE = 0x10000;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function servfail(): IterationOutcome {
  return { status: 'SERVFAIL', answers: [], authorities: [], negative: null };
}

function findSoa(records: readonly ResourceRecord<ResourceRecordData>[]): ResourceRecord<SoaRecordData> | null {
  const soa = records.find((rr) => rr.data.type === RRType.SOA);
  return (soa as ResourceRecord<SoaRecordData>) ?? null;
}

export class RecursiveResolver {
  private nextQueryId = 1;
  private readonly timeoutMs: number;
  private readonly maxReferrals: number;
  private readonly maxDepth: number;
  private readonly validator: DnsValidator | null;

  constructor(
    private readonly host: EndHost,
    private readonly rootHints: readonly IPAddress[],
    private readonly cache: DnsCache = new DnsCache(),
    options: RecursiveResolverOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReferrals = options.maxReferrals ?? DEFAULT_MAX_REFERRALS;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.validator = options.dnssec
      ? new DnsValidator(
          async (qname, qtype) => {
            const result = await this.resolveWithDepth(qname, qtype, 0, true);
            return { status: result.status, records: result.answers };
          },
          options.dnssec.anchors,
          { now: options.dnssec.now },
        )
      : null;
  }

  async resolve(qname: string, qtype: number): Promise<ResolutionResult> {
    return this.resolveWithDepth(qname, qtype, 0, false);
  }

  private async resolveWithDepth(
    qname: string, qtype: number, depth: number, raw: boolean,
  ): Promise<ResolutionResult> {
    if (!raw) {
      const cached = this.cache.lookup(qname, qtype);
      if (cached.kind === 'hit') {
        return { status: 'NOERROR', answers: cached.records, fromCache: true };
      }
      if (cached.kind === 'negative') {
        return {
          status: cached.rcode === DnsRcode.NXDOMAIN ? 'NXDOMAIN' : 'NOERROR',
          answers: [],
          fromCache: true,
        };
      }
    }
    if (depth > this.maxDepth) {
      return { status: 'SERVFAIL', answers: [], fromCache: false };
    }

    const outcome = await this.iterate(qname, qtype, depth, raw);

    let security: DnssecStatus | undefined;
    if (this.validator && !raw && outcome.status !== 'SERVFAIL') {
      security = outcome.answers.length > 0
        ? await this.validator.validateAnswer(outcome.answers)
        : await this.validator.validateNegative(qname, outcome.authorities);
      if (security === 'bogus') {
        return { status: 'SERVFAIL', answers: [], fromCache: false, security };
      }
    }

    if (!raw) {
      if (outcome.status === 'NOERROR' && outcome.answers.length > 0) {
        this.cache.storePositive(outcome.answers);
      } else if (outcome.negative) {
        const soa = findSoa(outcome.authorities);
        if (soa) {
          const rcode = outcome.negative === 'nxdomain' ? DnsRcode.NXDOMAIN : DnsRcode.NOERROR;
          this.cache.storeNegative(qname, qtype, rcode, soa);
        }
      }
    }

    return { status: outcome.status, answers: outcome.answers, fromCache: false, security };
  }

  private async iterate(
    qname: string, qtype: number, depth: number, raw: boolean,
  ): Promise<IterationOutcome> {
    let servers: readonly IPAddress[] = this.rootHints;

    for (let referral = 0; referral <= this.maxReferrals; referral++) {
      const response = await this.queryFirstReachable(servers, qname, qtype);
      if (!response) return servfail();

      if (response.flags.rcode === DnsRcode.NXDOMAIN) {
        return { status: 'NXDOMAIN', answers: [], authorities: response.authorities, negative: 'nxdomain' };
      }
      if (response.flags.rcode !== DnsRcode.NOERROR) return servfail();

      if (response.answers.length > 0) {
        return this.acceptAnswers(qtype, response.answers, depth, raw);
      }

      if (response.flags.aa) {
        return { status: 'NOERROR', answers: [], authorities: response.authorities, negative: 'nodata' };
      }

      const nextServers = await this.followReferral(response, depth, raw);
      if (!nextServers) return servfail();
      servers = nextServers;
    }
    return servfail();
  }

  private async acceptAnswers(
    qtype: number,
    answers: readonly ResourceRecord<ResourceRecordData>[],
    depth: number,
    raw: boolean,
  ): Promise<IterationOutcome> {
    const done = (records: readonly ResourceRecord<ResourceRecordData>[]): IterationOutcome =>
      ({ status: 'NOERROR', answers: records, authorities: [], negative: null });

    if (answers.some((rr) => rr.data.type === qtype)) {
      return done(answers);
    }

    const cnames = answers.filter((rr): rr is ResourceRecord<CnameRecordData> => rr.data.type === RRType.CNAME);
    if (cnames.length === 0 || qtype === RRType.CNAME) {
      return done(answers);
    }

    const target = cnames[cnames.length - 1].data.cname;
    const chased = await this.resolveWithDepth(target, qtype, depth + 1, raw || this.validator !== null);
    return {
      status: chased.status,
      answers: [...answers, ...chased.answers],
      authorities: [],
      negative: null,
    };
  }

  private async followReferral(
    response: DnsMessage, depth: number, raw: boolean,
  ): Promise<readonly IPAddress[] | null> {
    const nsRecords = response.authorities.filter(
      (rr): rr is ResourceRecord<NsRecordData> => rr.data.type === RRType.NS,
    );
    if (nsRecords.length === 0) return null;

    const nsNames = new Set(nsRecords.map((rr) => normalizeName(rr.data.nsdname)));
    const glue = response.additionals.filter(
      (rr): rr is ResourceRecord<ARecordData> =>
        rr.data.type === RRType.A && nsNames.has(normalizeName(rr.name)),
    );
    if (glue.length > 0) {
      return glue.map((rr) => rr.data.address);
    }

    for (const ns of nsRecords) {
      const nsResult = await this.resolveWithDepth(
        ns.data.nsdname, RRType.A, depth + 1, raw || this.validator !== null,
      );
      if (nsResult.status !== 'NOERROR') continue;
      const addresses = nsResult.answers
        .filter((rr): rr is ResourceRecord<ARecordData> => rr.data.type === RRType.A)
        .map((rr) => rr.data.address);
      if (addresses.length > 0) return addresses;
    }
    return null;
  }

  private async queryFirstReachable(
    servers: readonly IPAddress[],
    qname: string,
    qtype: number,
  ): Promise<DnsMessage | null> {
    for (const serverIP of servers) {
      const response = await queryAuthoritativeServer(this.host, serverIP, this.buildQuery(qname, qtype), {
        timeoutMs: this.timeoutMs,
      });
      if (response && response.flags.rcode !== DnsRcode.REFUSED) return response;
    }
    return null;
  }

  private buildQuery(qname: string, qtype: number): DnsMessage {
    const id = this.nextQueryId;
    this.nextQueryId = (this.nextQueryId + 1) % QUERY_ID_SPACE;
    return {
      id,
      flags: {
        qr: false, opcode: DnsOpcode.QUERY, aa: false, tc: false,
        rd: false, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
      },
      questions: [{ qname, qtype, qclass: DnsClass.IN }],
      answers: [],
      authorities: [],
      additionals: this.validator
        ? [makeOptRecord(DEFAULT_EDNS_PAYLOAD_SIZE, { dnssecOk: true })]
        : [],
    };
  }
}

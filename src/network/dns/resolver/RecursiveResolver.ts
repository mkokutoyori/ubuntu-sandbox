import type { IPAddress } from '@/network/core/types';
import type { EndHost } from '@/network/devices/EndHost';
import { DnsOpcode, DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType, DnsClass } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type {
  ResourceRecord, ResourceRecordData, SoaRecordData, NsRecordData, ARecordData, CnameRecordData,
} from '@/network/dns/wire/ResourceRecord';
import { queryAuthoritativeServer } from '@/network/dns/transport/DnsTcpTransport';
import { DnsCache } from '@/network/dns/resolver/DnsCache';

export type ResolutionStatus = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';

export interface ResolutionResult {
  readonly status: ResolutionStatus;
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly fromCache: boolean;
}

export interface RecursiveResolverOptions {
  readonly timeoutMs?: number;
  readonly maxReferrals?: number;
  readonly maxDepth?: number;
}

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_MAX_REFERRALS = 16;
const DEFAULT_MAX_DEPTH = 8;
const QUERY_ID_SPACE = 0x10000;

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

function servfail(): ResolutionResult {
  return { status: 'SERVFAIL', answers: [], fromCache: false };
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

  constructor(
    private readonly host: EndHost,
    private readonly rootHints: readonly IPAddress[],
    private readonly cache: DnsCache = new DnsCache(),
    options: RecursiveResolverOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReferrals = options.maxReferrals ?? DEFAULT_MAX_REFERRALS;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  async resolve(qname: string, qtype: number): Promise<ResolutionResult> {
    return this.resolveWithDepth(qname, qtype, 0);
  }

  private async resolveWithDepth(qname: string, qtype: number, depth: number): Promise<ResolutionResult> {
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
    if (depth > this.maxDepth) return servfail();
    return this.iterate(qname, qtype, depth);
  }

  private async iterate(qname: string, qtype: number, depth: number): Promise<ResolutionResult> {
    let servers: readonly IPAddress[] = this.rootHints;

    for (let referral = 0; referral <= this.maxReferrals; referral++) {
      const response = await this.queryFirstReachable(servers, qname, qtype);
      if (!response) return servfail();

      if (response.flags.rcode === DnsRcode.NXDOMAIN) {
        const soa = findSoa(response.authorities);
        if (soa) this.cache.storeNegative(qname, qtype, DnsRcode.NXDOMAIN, soa);
        return { status: 'NXDOMAIN', answers: [], fromCache: false };
      }
      if (response.flags.rcode !== DnsRcode.NOERROR) return servfail();

      if (response.answers.length > 0) {
        return this.acceptAnswers(qname, qtype, response.answers, depth);
      }

      if (response.flags.aa) {
        const soa = findSoa(response.authorities);
        if (soa) this.cache.storeNegative(qname, qtype, DnsRcode.NOERROR, soa);
        return { status: 'NOERROR', answers: [], fromCache: false };
      }

      const nextServers = await this.followReferral(response, depth);
      if (!nextServers) return servfail();
      servers = nextServers;
    }
    return servfail();
  }

  private async acceptAnswers(
    qname: string,
    qtype: number,
    answers: readonly ResourceRecord<ResourceRecordData>[],
    depth: number,
  ): Promise<ResolutionResult> {
    this.cache.storePositive(answers);

    if (answers.some((rr) => rr.data.type === qtype)) {
      return { status: 'NOERROR', answers, fromCache: false };
    }

    const cnames = answers.filter((rr): rr is ResourceRecord<CnameRecordData> => rr.data.type === RRType.CNAME);
    if (cnames.length === 0 || qtype === RRType.CNAME) {
      return { status: 'NOERROR', answers, fromCache: false };
    }

    const target = cnames[cnames.length - 1].data.cname;
    const chased = await this.resolveWithDepth(target, qtype, depth + 1);
    return {
      status: chased.status,
      answers: [...answers, ...chased.answers],
      fromCache: false,
    };
  }

  private async followReferral(response: DnsMessage, depth: number): Promise<readonly IPAddress[] | null> {
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
      const nsResult = await this.resolveWithDepth(ns.data.nsdname, RRType.A, depth + 1);
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
      additionals: [],
    };
  }
}

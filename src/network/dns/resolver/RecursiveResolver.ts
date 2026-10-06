import { simulationNowMs } from '@/network/core/SystemClock';

import type { IPAddress } from '@/network/core/types';
import { normalizeDnsName as normalizeName, isWithinDomain } from '@/network/dns/wire/DnsName';
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
import { DnsValidator, capTtlsToSignatures } from '@/network/dns/dnssec/DnsValidator';
import type { DnssecStatus } from '@/network/dns/dnssec/DnsValidator';

export type ResolutionStatus = 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';

export interface ResolutionResult {
  readonly status: ResolutionStatus;
  readonly answers: readonly ResourceRecord<ResourceRecordData>[];
  readonly authorities?: readonly ResourceRecord<ResourceRecordData>[];
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
  readonly forwardRecursively?: boolean;
  readonly dnssec?: RecursiveResolverDnssecOptions;
  readonly servfailTtlSeconds?: number;
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

function servfail(): IterationOutcome {
  return { status: 'SERVFAIL', answers: [], authorities: [], negative: null };
}

function findSoa(records: readonly ResourceRecord<ResourceRecordData>[]): ResourceRecord<SoaRecordData> | null {
  const soa = records.find((rr) => rr.data.type === RRType.SOA);
  return (soa as ResourceRecord<SoaRecordData>) ?? null;
}

function ownedByQuestion(
  qname: string, answers: readonly ResourceRecord<ResourceRecordData>[],
): ResourceRecord<ResourceRecordData>[] {
  const names = new Set([normalizeName(qname)]);
  const kept = new Set<ResourceRecord<ResourceRecordData>>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const rr of answers) {
      if (kept.has(rr) || !names.has(normalizeName(rr.name))) continue;
      kept.add(rr);
      grew = true;
      if (rr.data.type === RRType.CNAME) names.add(normalizeName(rr.data.cname));
    }
  }
  return answers.filter((rr) => kept.has(rr));
}

export class RecursiveResolver {
  private nextQueryId = 1;
  private readonly timeoutMs: number;
  private readonly maxReferrals: number;
  private readonly maxDepth: number;
  private readonly forwardRecursively: boolean;
  private validatorInstance: DnsValidator | null = null;
  private readonly dnssecOptions: RecursiveResolverDnssecOptions | null;
  private readonly servfailTtlSeconds: number;

  constructor(
    private readonly host: EndHost,
    private readonly rootHints: readonly IPAddress[],
    private readonly cache: DnsCache = new DnsCache(),
    options: RecursiveResolverOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxReferrals = options.maxReferrals ?? DEFAULT_MAX_REFERRALS;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.forwardRecursively = options.forwardRecursively ?? false;
    this.dnssecOptions = options.dnssec ?? null;
    this.servfailTtlSeconds = options.servfailTtlSeconds ?? 0;
  }

  private nowSeconds(): number {
    return (this.dnssecOptions?.now ?? (() => Math.floor(simulationNowMs() / 1000)))();
  }

  private get validator(): DnsValidator | null {
    const options = this.dnssecOptions;
    if (options === null || options.anchors.length === 0) return null;
    this.validatorInstance ??= new DnsValidator(
      async (qname, qtype) => {
        const result = await this.resolveWithDepth(qname, qtype, 0, true);
        return { status: result.status, records: result.answers, authorities: result.authorities };
      },
      options.anchors,
      { now: options.now },
    );
    return this.validatorInstance;
  }

  async resolve(
    qname: string, qtype: number, options: { readonly checkingDisabled?: boolean } = {},
  ): Promise<ResolutionResult> {
    return this.resolveWithDepth(qname, qtype, 0, options.checkingDisabled === true);
  }

  private async resolveWithDepth(
    qname: string, qtype: number, depth: number, raw: boolean,
  ): Promise<ResolutionResult> {
    if (!raw) {
      const cached = this.cache.lookup(qname, qtype);
      if (cached.kind === 'hit') {
        return { status: 'NOERROR', answers: cached.records, fromCache: true, security: cached.security };
      }
      if (cached.kind === 'servfail') {
        return { status: 'SERVFAIL', answers: [], fromCache: true };
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
        ? await this.validator.validateAnswer(outcome.answers, outcome.authorities)
        : await this.validator.validateNegative(qname, outcome.authorities, outcome.negative === 'nxdomain');
      if (security === 'bogus') {
        this.cache.storeServfail(qname, qtype, this.servfailTtlSeconds);
        return { status: 'SERVFAIL', answers: [], fromCache: false, security };
      }
    }
    if (!raw && outcome.status === 'SERVFAIL') {
      this.cache.storeServfail(qname, qtype, this.servfailTtlSeconds);
    }

    const answers = security === 'secure'
      ? capTtlsToSignatures(outcome.answers, this.nowSeconds())
      : outcome.answers;

    if (!raw) {
      if (outcome.status === 'NOERROR' && answers.length > 0) {
        this.cache.storePositive(answers, undefined, security);
      } else if (outcome.negative) {
        const soa = findSoa(outcome.authorities);
        if (soa) {
          const rcode = outcome.negative === 'nxdomain' ? DnsRcode.NXDOMAIN : DnsRcode.NOERROR;
          this.cache.storeNegative(qname, qtype, rcode, soa);
        }
      }
    }

    return {
      status: outcome.status, answers, authorities: outcome.authorities,
      fromCache: false, security,
    };
  }

  private async iterate(
    qname: string, qtype: number, depth: number, raw: boolean,
  ): Promise<IterationOutcome> {
    let servers: readonly IPAddress[] = this.rootHints;
    let zoneCut = '';

    if (this.forwardRecursively) return this.forward(servers, qname, qtype);

    for (let referral = 0; referral <= this.maxReferrals; referral++) {
      const response = await this.queryFirstReachable(servers, qname, qtype);
      if (!response) return servfail();

      if (response.flags.rcode === DnsRcode.NXDOMAIN) {
        return { status: 'NXDOMAIN', answers: [], authorities: response.authorities, negative: 'nxdomain' };
      }
      if (response.flags.rcode !== DnsRcode.NOERROR) return servfail();

      if (response.answers.length > 0) {
        const owned = ownedByQuestion(qname, response.answers);
        if (owned.length === 0) return servfail();
        return this.acceptAnswers(qtype, owned, response.authorities, depth, raw);
      }

      if (response.flags.aa) {
        return { status: 'NOERROR', answers: [], authorities: response.authorities, negative: 'nodata' };
      }

      const referral = await this.followReferral(response, qname, zoneCut, depth, raw);
      if (!referral) return servfail();
      servers = referral.servers;
      zoneCut = referral.zone;
    }
    return servfail();
  }

  private async forward(
    servers: readonly IPAddress[], qname: string, qtype: number,
  ): Promise<IterationOutcome> {
    const response = await this.queryFirstReachable(servers, qname, qtype);
    if (!response) return servfail();
    if (response.flags.rcode === DnsRcode.NXDOMAIN) {
      return { status: 'NXDOMAIN', answers: [], authorities: response.authorities, negative: 'nxdomain' };
    }
    if (response.flags.rcode !== DnsRcode.NOERROR) return servfail();
    const owned = ownedByQuestion(qname, response.answers);
    if (owned.length > 0) {
      return { status: 'NOERROR', answers: owned, authorities: response.authorities, negative: null };
    }
    if (response.answers.length > 0) return servfail();
    return { status: 'NOERROR', answers: [], authorities: response.authorities, negative: 'nodata' };
  }

  private async acceptAnswers(
    qtype: number,
    answers: readonly ResourceRecord<ResourceRecordData>[],
    authorities: readonly ResourceRecord<ResourceRecordData>[],
    depth: number,
    raw: boolean,
  ): Promise<IterationOutcome> {
    const done = (records: readonly ResourceRecord<ResourceRecordData>[]): IterationOutcome =>
      ({ status: 'NOERROR', answers: records, authorities, negative: null });

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
    response: DnsMessage, qname: string, zoneCut: string, depth: number, raw: boolean,
  ): Promise<{ servers: readonly IPAddress[]; zone: string } | null> {
    const target = normalizeName(qname);
    const nsRecords = response.authorities.filter(
      (rr): rr is ResourceRecord<NsRecordData> => {
        if (rr.data.type !== RRType.NS) return false;
        const owner = normalizeName(rr.name);
        return owner !== zoneCut && isWithinDomain(owner, zoneCut) && isWithinDomain(target, owner);
      },
    );
    if (nsRecords.length === 0) return null;
    const zone = normalizeName(nsRecords[0].name);

    const nsNames = new Set(nsRecords.map((rr) => normalizeName(rr.data.nsdname)));
    const glue = response.additionals.filter(
      (rr): rr is ResourceRecord<ARecordData> =>
        rr.data.type === RRType.A && nsNames.has(normalizeName(rr.name))
        && isWithinDomain(normalizeName(rr.name), zoneCut),
    );
    if (glue.length > 0) {
      return { servers: glue.map((rr) => rr.data.address), zone };
    }

    for (const ns of nsRecords) {
      const nsResult = await this.resolveWithDepth(
        ns.data.nsdname, RRType.A, depth + 1, raw || this.validator !== null,
      );
      if (nsResult.status !== 'NOERROR') continue;
      const addresses = nsResult.answers
        .filter((rr): rr is ResourceRecord<ARecordData> => rr.data.type === RRType.A)
        .map((rr) => rr.data.address);
      if (addresses.length > 0) return { servers: addresses, zone };
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
        rd: this.forwardRecursively, ra: false, ad: false, cd: false, rcode: DnsRcode.NOERROR,
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

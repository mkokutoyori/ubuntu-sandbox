import { DnsRcode } from '@/network/dns/wire/DnsHeaderFlags';
import { RRType } from '@/network/dns/wire/RRType';
import type { DnsMessage } from '@/network/dns/wire/DnsMessage';
import type { INssSource } from './INssSource';
import { nssNotFound as NOTFOUND } from './nssResult';
import { searchCandidates } from './ResolvConf';
import type { NssEnumResult, NssHostEntry, NssResult } from './types';

export interface DnsWireStubResolver {
  nameservers(): string[];
  query(serverIp: string, name: string, qtype: 'A' | 'AAAA' | 'PTR'): DnsMessage | null;
  /**
   * Interrogation qui a le droit d'attendre. C'est elle qui rend le
   * chemin NSS praticable quand le résolveur doit valider (DNSSEC) ou
   * chiffrer (DoT) : ni l'un ni l'autre ne peut tenir dans la pile
   * d'appel de `query`.
   */
  queryAsync?(serverIp: string, name: string, qtype: 'A' | 'AAAA' | 'PTR'): Promise<DnsMessage | null>;
  searchDomains?(): string[];
  ndots?(): number;
}

/** Les interrogations à faire selon la famille demandée. */
function familyLookups(
  family?: 2 | 10,
): Array<{ qtype: 'A' | 'AAAA'; rrType: number; af: 2 | 10 }> {
  if (family === 10) return [{ qtype: 'AAAA', rrType: RRType.AAAA, af: 10 }];
  if (family === 2) return [{ qtype: 'A', rrType: RRType.A, af: 2 }];
  return [
    { qtype: 'A', rrType: RRType.A, af: 2 },
    { qtype: 'AAAA', rrType: RRType.AAAA, af: 10 },
  ];
}

export class DnsNssSource implements INssSource {
  readonly name = 'dns';

  private wire: DnsWireStubResolver | null = null;

  setWireResolver(resolver: DnsWireStubResolver | null): void {
    this.wire = resolver;
  }

  /**
   * Kept so existing callers still compile; the answer no longer changes
   * anything, since names are resolved by asking a resolver or not at all.
   */
  setCabledProbe(_probe: (() => boolean) | null): void {}

  gethostbyname(name: string, family?: 2 | 10): NssResult<NssHostEntry[]> {
    const servers = this.wire?.nameservers() ?? [];
    if (this.wire && servers.length > 0) {
      const search = this.wire.searchDomains?.() ?? [];
      const ndots = this.wire.ndots?.() ?? 1;
      const candidates = searchCandidates(name, search, ndots);
      let last: NssResult<NssHostEntry[]> = NOTFOUND();
      for (const candidate of candidates) {
        last = this.wireLookup(servers, candidate, family);
        if (last.status === 'SUCCESS') return last;
      }
      return last;
    }
    // With no nameserver configured there is no answer. Reading every
    // device in the simulation to match a hostname was the old fallback
    // (docs/PRD-Frame-Only-Refactor.md P6).
    return NOTFOUND();
  }

  gethostbyaddr(addr: string): NssResult<NssHostEntry> {
    const servers = this.wire?.nameservers() ?? [];
    if (this.wire && servers.length > 0) {
      return this.wirePtrLookup(servers, addr);
    }
    return NOTFOUND();
  }

  async gethostbynameAsync(name: string, family?: 2 | 10): Promise<NssResult<NssHostEntry[]>> {
    const servers = this.wire?.nameservers() ?? [];
    if (!this.wire || servers.length === 0) return NOTFOUND();
    const search = this.wire.searchDomains?.() ?? [];
    const ndots = this.wire.ndots?.() ?? 1;
    let last: NssResult<NssHostEntry[]> = NOTFOUND();
    for (const candidate of searchCandidates(name, search, ndots)) {
      last = await this.wireLookupAsync(servers, candidate, family);
      if (last.status === 'SUCCESS') return last;
    }
    return last;
  }

  async gethostbyaddrAsync(addr: string): Promise<NssResult<NssHostEntry>> {
    const servers = this.wire?.nameservers() ?? [];
    if (!this.wire || servers.length === 0) return NOTFOUND();
    return this.readPtr(addr, await this.queryAnyAsync(servers, addr, 'PTR'));
  }

  enumHosts(): NssEnumResult<NssHostEntry> {
    return { status: 'UNAVAIL', entries: [] };
  }

  private queryAny(
    servers: string[], name: string, qtype: 'A' | 'AAAA' | 'PTR',
  ): DnsMessage | null {
    for (const server of servers) {
      const resp = this.wire!.query(server, name, qtype);
      if (resp) return resp;
    }
    return null;
  }

  private wireLookup(
    servers: string[], name: string, family?: 2 | 10,
  ): NssResult<NssHostEntry[]> {
    const matches: NssHostEntry[] = [];
    let answered = false;
    for (const { qtype, rrType, af } of familyLookups(family)) {
      const resp = this.queryAny(servers, name, qtype);
      const verdict = this.collect(resp, name, rrType, af, matches);
      if (verdict) return verdict;
      if (resp) answered = true;
    }
    return this.settle(answered, matches);
  }

  private wirePtrLookup(servers: string[], addr: string): NssResult<NssHostEntry> {
    return this.readPtr(addr, this.queryAny(servers, addr, 'PTR'));
  }

  private readPtr(addr: string, resp: DnsMessage | null): NssResult<NssHostEntry> {
    if (!resp) return { status: 'TRYAGAIN' };
    if (resp.flags.rcode !== DnsRcode.NOERROR || resp.answers.length === 0) return NOTFOUND();
    const ptr = resp.answers.find(a => a.data.type === RRType.PTR);
    if (!ptr) return NOTFOUND();
    return {
      status: 'SUCCESS',
      entry: {
        canonicalName: (ptr.data as { ptrdname: string }).ptrdname,
        addressFamily: addr.includes(':') ? 10 : 2,
        address: addr,
        aliases: [],
      },
    };
  }

  private async queryAnyAsync(
    servers: string[], name: string, qtype: 'A' | 'AAAA' | 'PTR',
  ): Promise<DnsMessage | null> {
    for (const server of servers) {
      const resp = this.wire!.queryAsync
        ? await this.wire!.queryAsync(server, name, qtype)
        : this.wire!.query(server, name, qtype);
      if (resp) return resp;
    }
    return null;
  }

  private async wireLookupAsync(
    servers: string[], name: string, family?: 2 | 10,
  ): Promise<NssResult<NssHostEntry[]>> {
    const matches: NssHostEntry[] = [];
    let answered = false;
    for (const { qtype, rrType, af } of familyLookups(family)) {
      const resp = await this.queryAnyAsync(servers, name, qtype);
      const verdict = this.collect(resp, name, rrType, af, matches);
      if (verdict) return verdict;
      if (resp) answered = true;
    }
    return this.settle(answered, matches);
  }

  /**
   * Range les réponses d'un type dans `matches`. Rend un verdict
   * seulement quand la réponse tranche à elle seule — et jamais si un
   * autre type a déjà répondu : une recherche A+AAAA dont seule la
   * moitié aboutit doit rendre ce qu'elle a, comme glibc.
   */
  private collect(
    resp: DnsMessage | null, name: string, rrType: number, af: 2 | 10,
    matches: NssHostEntry[],
  ): NssResult<NssHostEntry[]> | null {
    if (!resp) return null;
    if (resp.flags.rcode === DnsRcode.NXDOMAIN) return matches.length ? null : NOTFOUND();
    if (resp.flags.rcode !== DnsRcode.NOERROR) {
      return matches.length ? null : { status: 'TRYAGAIN' };
    }
    const canonicalName = (resp.questions[0]?.qname ?? name).toLowerCase();
    for (const answer of resp.answers) {
      if (answer.data.type !== rrType) continue;
      matches.push({
        canonicalName,
        addressFamily: af,
        address: (answer.data as { address: { toString(): string } }).address.toString(),
        aliases: [],
      });
    }
    return null;
  }

  private settle(answered: boolean, matches: NssHostEntry[]): NssResult<NssHostEntry[]> {
    if (!answered) return { status: 'TRYAGAIN' };
    if (matches.length) return { status: 'SUCCESS', entry: matches };
    return NOTFOUND();
  }

}

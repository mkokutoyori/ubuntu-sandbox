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
  searchDomains?(): string[];
  ndots?(): number;
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
    const lookups: Array<{ qtype: 'A' | 'AAAA'; rrType: number; af: 2 | 10 }> =
      family === 10 ? [{ qtype: 'AAAA', rrType: RRType.AAAA, af: 10 }]
      : family === 2 ? [{ qtype: 'A', rrType: RRType.A, af: 2 }]
      : [{ qtype: 'A', rrType: RRType.A, af: 2 }, { qtype: 'AAAA', rrType: RRType.AAAA, af: 10 }];
    const matches: NssHostEntry[] = [];
    let answered = false;

    for (const { qtype, rrType, af } of lookups) {
      const resp = this.queryAny(servers, name, qtype);
      if (!resp) continue;
      answered = true;
      if (resp.flags.rcode === DnsRcode.NXDOMAIN) return NOTFOUND();
      if (resp.flags.rcode !== DnsRcode.NOERROR) return { status: 'TRYAGAIN' };
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
    }

    if (!answered) return { status: 'TRYAGAIN' };
    if (matches.length) return { status: 'SUCCESS', entry: matches };
    return NOTFOUND();
  }

  private wirePtrLookup(servers: string[], addr: string): NssResult<NssHostEntry> {
    const resp = this.queryAny(servers, addr, 'PTR');
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

}

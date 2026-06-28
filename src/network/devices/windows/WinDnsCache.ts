import type { DnsRecord } from '@/network/dns/DnsWire';

/**
 * Windows DNS Resolver Cache — backs `ipconfig /displaydns` and
 * `ipconfig /flushdns`. Entries are populated by the host's resolver
 * (`WindowsPC.resolveHostname`) on every successful DNS response and
 * expire when their TTL runs out, just like the real Windows client.
 */
export class WindowsDnsCache {
  private readonly entries = new Map<string, CachedDnsEntry>();
  /** Per-instance "now" hook — overridable for deterministic tests. */
  now: () => number = () => Date.now();

  /** Add (or refresh) cache entries for one DNS response. Every record
   *  in the answers list becomes its own cache entry — A, AAAA, CNAME,
   *  PTR, MX, … — keyed by the (lower-cased) record name + type. */
  store(qname: string, records: readonly DnsRecord[]): void {
    if (records.length === 0) return;
    const insertedAt = this.now();
    for (const r of records) {
      const key = this.key(r.name || qname, r.type);
      this.entries.set(key, {
        name: r.name || qname,
        type: r.type,
        value: r.value,
        ttl: r.ttl,
        insertedAt,
      });
    }
  }

  /** Drop everything — backs `/flushdns`. */
  flush(): void { this.entries.clear(); }

  /** Number of non-expired cached records. */
  size(): number { return this.activeEntries().length; }

  /** Return every cached entry whose TTL has not yet elapsed. */
  activeEntries(): CachedDnsEntry[] {
    const now = this.now();
    const out: CachedDnsEntry[] = [];
    for (const [key, e] of this.entries) {
      if (now - e.insertedAt >= e.ttl * 1000) {
        this.entries.delete(key);
        continue;
      }
      out.push(e);
    }
    return out;
  }

  private key(name: string, type: string): string {
    return `${name.toLowerCase()}::${type.toUpperCase()}`;
  }
}

export interface CachedDnsEntry {
  name: string;
  type: string;
  value: string;
  ttl: number;
  /** Wall-clock at which the entry was placed in the cache. The
   *  remaining-TTL projection used by `ipconfig /displaydns` is
   *  `ttl - floor((now - insertedAt) / 1000)`. */
  insertedAt: number;
}

const TYPE_NUM: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28,
};

const SECTION_HEADER = 'Windows IP Configuration';

/**
 * Render a cache the way the real Windows `ipconfig /displaydns`
 * renders one: one paragraph per record, dotted alignment, plus the
 * dynamic / hosts-file section label. The empty-cache form matches
 * Windows verbatim so the output stays consistent with the prior stub.
 */
export function renderDisplayDns(cache: WindowsDnsCache): string {
  const records = cache.activeEntries();
  if (records.length === 0) {
    return `${SECTION_HEADER}\n\n  Record Name . . . . . : (no entries)`;
  }
  const now = cache.now();
  const out: string[] = [`${SECTION_HEADER}\n`];
  for (const r of records) {
    const elapsed = Math.floor((now - r.insertedAt) / 1000);
    const remaining = Math.max(0, r.ttl - elapsed);
    out.push(`    ${r.name}`);
    out.push(`    ----------------------------------------`);
    out.push(`    Record Name . . . . . : ${r.name}`);
    out.push(`    Record Type . . . . . : ${TYPE_NUM[r.type.toUpperCase()] ?? 0}`);
    out.push(`    Time To Live  . . . . : ${remaining}`);
    out.push(`    Data Length . . . . . : ${r.value.length}`);
    out.push(`    Section . . . . . . . : Answer`);
    const valueLabel = (r.type === 'A' || r.type === 'AAAA') ? 'Record' : 'Data';
    out.push(`    ${r.type} (Host) ${valueLabel}  . . . : ${r.value}`);
    out.push('');
  }
  return out.join('\n').trimEnd();
}

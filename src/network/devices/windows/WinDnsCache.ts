import type { DnsRecord } from '@/network/dns/DnsWire';

export class WindowsDnsCache {
  private readonly entries = new Map<string, CachedDnsEntry>();
  now: () => number = () => Date.now();

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

  flush(): void { this.entries.clear(); }

  size(): number { return this.activeEntries().length; }

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
  insertedAt: number;
}

const TYPE_NUM: Record<string, number> = {
  A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28,
};

const SECTION_HEADER = 'Windows IP Configuration';

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

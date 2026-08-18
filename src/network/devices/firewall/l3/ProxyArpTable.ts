import { tryIpToUint32 } from '../../../core/ip';

export interface ProxyArpEntry {
  readonly from: string;
  readonly to?: string;
  readonly iface?: string;
}

export function proxyOwnerKey(kind: string, name: string): string {
  return `${kind}:${name}`;
}

export class ProxyArpTable {
  private readonly owners = new Map<string, readonly ProxyArpEntry[]>();

  set(owner: string, entries: readonly ProxyArpEntry[]): void {
    if (entries.length === 0) { this.owners.delete(owner); return; }
    this.owners.set(owner, Object.freeze([...entries]));
  }

  clear(owner: string): void {
    this.owners.delete(owner);
  }

  answers(address: string, iface: string): boolean {
    const value = tryIpToUint32(address);
    if (value === null) return false;

    for (const entries of this.owners.values()) {
      for (const entry of entries) {
        if (entry.iface !== undefined && entry.iface !== iface) continue;

        const from = tryIpToUint32(entry.from);
        const to = tryIpToUint32(entry.to ?? entry.from);
        if (from === null || to === null) continue;
        if (value >= from && value <= to) return true;
      }
    }
    return false;
  }

  all(): readonly ProxyArpEntry[] {
    const out: ProxyArpEntry[] = [];
    for (const entries of this.owners.values()) out.push(...entries);
    return Object.freeze(out);
  }
}

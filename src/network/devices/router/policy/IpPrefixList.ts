import { IPAddress, IPv6Address } from '../../../core/types';

export type PrefixAction = 'permit' | 'deny';

export interface IpPrefixEntry {
  index: number;
  action: PrefixAction;
  network: string;
  prefixLength: number;
  lessEqual?: number;
  greaterEqual?: number;
}

export class IpPrefixList {
  readonly name: string;
  readonly family: 'ipv4' | 'ipv6';
  private entries = new Map<number, IpPrefixEntry>();
  private nextAutoIndex = 10;

  constructor(name: string, family: 'ipv4' | 'ipv6' = 'ipv4') {
    this.name = name;
    this.family = family;
  }

  upsert(entry: Omit<IpPrefixEntry, 'index'> & { index?: number }): IpPrefixEntry {
    const idx = entry.index ?? this.nextAutoIndex;
    if (entry.index === undefined) this.nextAutoIndex = idx + 10;
    else this.nextAutoIndex = Math.max(this.nextAutoIndex, idx + 10);
    const full: IpPrefixEntry = {
      index: idx,
      action: entry.action,
      network: entry.network,
      prefixLength: entry.prefixLength,
      lessEqual: entry.lessEqual,
      greaterEqual: entry.greaterEqual,
    };
    this.entries.set(idx, full);
    return full;
  }

  remove(index: number): boolean { return this.entries.delete(index); }
  clear(): void { this.entries.clear(); }

  list(): IpPrefixEntry[] {
    return [...this.entries.values()].sort((a, b) => a.index - b.index);
  }

  evaluate(network: string, prefixLength: number): PrefixAction | null {
    for (const e of this.list()) {
      if (this.matches(e, network, prefixLength)) return e.action;
    }
    return null;
  }

  private matches(e: IpPrefixEntry, network: string, prefixLength: number): boolean {
    if (this.family === 'ipv4') {
      try {
        const want = new IPAddress(e.network).toUint32();
        const got = new IPAddress(network).toUint32();
        const maskBits = e.prefixLength;
        const mask = maskBits === 0 ? 0 : (0xffffffff << (32 - maskBits)) >>> 0;
        if ((got & mask) !== (want & mask)) return false;
      } catch { return false; }
    } else {
      try {
        const want = new IPv6Address(e.network).getNetworkPrefix(e.prefixLength).toString();
        const got = new IPv6Address(network).getNetworkPrefix(e.prefixLength).toString();
        if (want !== got) return false;
      } catch { return false; }
    }
    if (e.greaterEqual !== undefined && prefixLength < e.greaterEqual) return false;
    if (e.lessEqual !== undefined && prefixLength > e.lessEqual) return false;
    if (e.greaterEqual === undefined && e.lessEqual === undefined && prefixLength !== e.prefixLength) return false;
    return true;
  }
}

export class IpPrefixListStore {
  private lists = new Map<string, IpPrefixList>();
  private listsV6 = new Map<string, IpPrefixList>();

  upsert(name: string, family: 'ipv4' | 'ipv6' = 'ipv4'): IpPrefixList {
    const map = family === 'ipv4' ? this.lists : this.listsV6;
    let list = map.get(name);
    if (!list) { list = new IpPrefixList(name, family); map.set(name, list); }
    return list;
  }
  get(name: string, family: 'ipv4' | 'ipv6' = 'ipv4'): IpPrefixList | undefined {
    return (family === 'ipv4' ? this.lists : this.listsV6).get(name);
  }
  remove(name: string, family: 'ipv4' | 'ipv6' = 'ipv4'): boolean {
    return (family === 'ipv4' ? this.lists : this.listsV6).delete(name);
  }
  listV4(): IpPrefixList[] { return [...this.lists.values()]; }
  listV6(): IpPrefixList[] { return [...this.listsV6.values()]; }
  removeEntry(name: string, index: number, family: 'ipv4' | 'ipv6' = 'ipv4'): boolean {
    return this.get(name, family)?.remove(index) ?? false;
  }

  renderHuawei(family: 'ipv4' | 'ipv6' = 'ipv4'): string {
    const lists = family === 'ipv4' ? this.listV4() : this.listV6();
    if (lists.length === 0) return '';
    const out: string[] = [];
    const kw = family === 'ipv4' ? 'ip ip-prefix' : 'ip ipv6-prefix';
    for (const l of lists) {
      for (const e of l.list()) {
        const parts = [kw, l.name, 'index', String(e.index), e.action, `${e.network}`, String(e.prefixLength)];
        if (e.greaterEqual !== undefined) parts.push('greater-equal', String(e.greaterEqual));
        if (e.lessEqual !== undefined) parts.push('less-equal', String(e.lessEqual));
        out.push(parts.join(' '));
      }
    }
    return out.join('\n');
  }
}

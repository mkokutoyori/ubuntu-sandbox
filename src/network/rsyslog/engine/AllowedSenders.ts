import { IPAddress, IPv6Address, SubnetMask } from '@/network/core/types';
import { fnmatch } from '@/network/devices/linux/fs/Glob';

export type SenderVerdict = 'denied' | 'allowed' | 'needs-name';

type AllowedEntry =
  | { readonly kind: 'ipv4'; readonly address: IPAddress; readonly bits: number }
  | { readonly kind: 'ipv6'; readonly address: IPv6Address; readonly bits: number }
  | { readonly kind: 'name'; readonly pattern: string };

export interface AllowedSenderEnvironment {
  report(text: string): void;
  disableDns: boolean;
  aclDontResolve: boolean;
  aclAddHostnameOnFail: boolean;
  resolve(name: string): { addresses: string[] } | { error: string };
}

export class AllowedSenderList {
  private readonly entries: AllowedEntry[] = [];

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }

  private addEntry(entry: AllowedEntry): void {
    this.entries.push(entry);
  }

  addAddress(text: string, requestedBits: number | null, environment: AllowedSenderEnvironment): 'added' | 'ignored' | 'error' {
    let host = text;
    let ipv6Literal = false;
    if (host.startsWith('[')) {
      const close = host.indexOf(']');
      if (close < 0) return 'error';
      host = host.slice(1, close);
      ipv6Literal = true;
    }
    if (ipv6Literal) {
      const v6 = IPv6Address.tryParse(host);
      if (v6 !== null) return this.addNumeric({ kind: 'ipv6', address: v6, bits: requestedBits ?? 128 }, environment);
    } else {
      const v4 = IPAddress.tryParse(host);
      if (v4 !== null) return this.addNumeric({ kind: 'ipv4', address: v4, bits: requestedBits ?? 32 }, environment);
    }
    return this.addHostName(host, environment);
  }

  private addNumeric(entry: Extract<AllowedEntry, { kind: 'ipv4' | 'ipv6' }>, environment: AllowedSenderEnvironment): 'added' {
    let bits = entry.bits;
    if (bits === 0) {
      environment.report(
        'You can not specify 0 bits of the netmask, this would match ALL systems. If you really intend to do that, remove all $AllowedSender directives.',
      );
    }
    const limit = entry.kind === 'ipv4' ? 32 : 128;
    if (bits < 1 || bits > limit) {
      environment.report(`Invalid number of bits (${bits}) in IPv${entry.kind === 'ipv4' ? 4 : 6} address - adjusted to ${limit}`);
      bits = limit;
    }
    if (entry.kind === 'ipv4') {
      this.addEntry({ kind: 'ipv4', address: entry.address.networkAddress(SubnetMask.fromCIDR(bits)), bits });
    } else {
      this.addEntry({ kind: 'ipv6', address: entry.address.getNetworkPrefix(bits), bits });
    }
    return 'added';
  }

  private addHostName(name: string, environment: AllowedSenderEnvironment): 'added' | 'ignored' | 'error' {
    if (environment.disableDns) {
      environment.report('Ignoring hostname based ACLs because DNS is disabled.');
      return 'added';
    }
    if (!name.includes('*') && !name.includes('?') && !environment.aclDontResolve) {
      const resolution = environment.resolve(name);
      if ('error' in resolution) {
        environment.report(`DNS error: Can't resolve "${name}"`);
        if (environment.aclAddHostnameOnFail) {
          environment.report(`Adding hostname "${name}" to ACL as a wildcard entry.`);
          this.addEntry({ kind: 'name', pattern: name });
          return 'added';
        }
        environment.report(`Hostname "${name}" WON'T be added to ACL.`);
        return 'ignored';
      }
      for (const address of resolution.addresses) {
        const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
        const v4 = IPAddress.tryParse(mapped === null ? address : mapped[1]);
        if (v4 !== null) {
          this.addEntry({ kind: 'ipv4', address: v4, bits: 32 });
          continue;
        }
        const v6 = IPv6Address.tryParse(address);
        if (v6 !== null) this.addEntry({ kind: 'ipv6', address: v6, bits: 128 });
      }
      return 'added';
    }
    this.addEntry({ kind: 'name', pattern: name });
    return 'added';
  }

  verdict(fromIp: string, fromHost: string, checkDns: boolean): SenderVerdict {
    if (this.entries.length === 0) return 'allowed';
    let needsName = false;
    for (const entry of this.entries) {
      if (entry.kind === 'name') {
        if (!checkDns) {
          needsName = true;
          continue;
        }
        if (fnmatch(entry.pattern.toLowerCase(), fromHost.toLowerCase())) return 'allowed';
        continue;
      }
      if (this.matchesAddress(entry, fromIp)) return 'allowed';
    }
    return needsName ? 'needs-name' : 'denied';
  }

  private matchesAddress(entry: Extract<AllowedEntry, { kind: 'ipv4' | 'ipv6' }>, fromIp: string): boolean {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(fromIp);
    const v4 = IPAddress.tryParse(mapped === null ? fromIp : mapped[1]);
    if (v4 !== null) {
      if (entry.kind === 'ipv4') return v4.isInSameSubnet(entry.address, SubnetMask.fromCIDR(entry.bits));
      return false;
    }
    const v6 = IPv6Address.tryParse(fromIp);
    if (v6 === null || entry.kind !== 'ipv6') return false;
    return v6.isInSameSubnet(entry.address, entry.bits);
  }
}

export interface ParsedSenderEntry {
  readonly address: string;
  readonly bits: number | null;
}

export function parseAllowedSenderEntries(text: string): { entries: ParsedSenderEntry[]; error: boolean } {
  const entries: ParsedSenderEntry[] = [];
  let index = 0;
  const skipSeparators = (): void => {
    while (index < text.length && (text[index] === ',' || /\s/.test(text[index]))) index++;
  };
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index >= text.length || text[index] === '#') break;
    const start = index;
    while (index < text.length && text[index] !== '/' && text[index] !== ',' && !/\s/.test(text[index])) index++;
    const address = text.slice(start, index);
    let bits: number | null = null;
    if (text[index] === '/') {
      index++;
      const digits = /^\d+/.exec(text.slice(index))?.[0];
      if (digits === undefined) return { entries, error: true };
      bits = Number(digits);
      index += digits.length;
    }
    entries.push({ address, bits });
    skipSeparators();
  }
  return { entries, error: false };
}

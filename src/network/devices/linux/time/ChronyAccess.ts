import { IPAddress } from '../../../core/types';

export interface ChronySubnet {
  readonly network: number;
  readonly prefix: number;
}

interface AccessEntry {
  readonly subnet: ChronySubnet;
  readonly allowed: boolean;
}

function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

export function parseChronySubnet(text: string): ChronySubnet | null {
  if (text === '' || text === 'all') return { network: 0, prefix: 0 };
  const [addressPart, lengthPart, extra] = text.split('/');
  if (extra !== undefined || addressPart === '') return null;
  const octets = addressPart.split('.');
  if (octets.length > 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet) || Number(octet) > 255)) return null;
  const padded = [...octets, ...Array(4 - octets.length).fill('0')].join('.');
  const address = IPAddress.tryParse(padded);
  if (address === null) return null;
  let prefix = octets.length * 8;
  if (lengthPart !== undefined) {
    if (/^\d+$/.test(lengthPart)) prefix = Number(lengthPart);
    else {
      const mask = IPAddress.tryParse(lengthPart);
      if (mask === null) return null;
      const bits = mask.toUint32().toString(2).padStart(32, '0');
      if (!/^1*0*$/.test(bits)) return null;
      prefix = bits.indexOf('0') === -1 ? 32 : bits.indexOf('0');
    }
    if (prefix > 32) return null;
  }
  return { network: (address.toUint32() & prefixMask(prefix)) >>> 0, prefix };
}

export function formatChronySubnet(subnet: ChronySubnet): string {
  return `${new IPAddress([
    subnet.network >>> 24, (subnet.network >>> 16) & 255, (subnet.network >>> 8) & 255, subnet.network & 255,
  ])}/${subnet.prefix}`;
}

export class ChronyAccessTable {
  private entries: AccessEntry[] = [];

  clear(): void { this.entries = []; }

  apply(allowed: boolean, subnet: ChronySubnet, includingChildren: boolean): void {
    this.entries = this.entries.filter((entry) => {
      const same = entry.subnet.prefix === subnet.prefix && entry.subnet.network === subnet.network;
      if (same) return false;
      if (!includingChildren) return true;
      return !(entry.subnet.prefix > subnet.prefix
        && ((entry.subnet.network & prefixMask(subnet.prefix)) >>> 0) === subnet.network);
    });
    this.entries.push({ subnet, allowed });
  }

  isAllowed(address: IPAddress): boolean {
    const value = address.toUint32();
    let best: AccessEntry | null = null;
    for (const entry of this.entries) {
      if (((value & prefixMask(entry.subnet.prefix)) >>> 0) !== entry.subnet.network) continue;
      if (best === null || entry.subnet.prefix >= best.subnet.prefix) best = entry;
    }
    return best?.allowed ?? false;
  }
}


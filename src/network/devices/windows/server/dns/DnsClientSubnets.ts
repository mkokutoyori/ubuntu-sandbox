import { IPAddress, IPv6Address } from '@/network/core/types';
import { cidrPrefixLength } from '@/network/core/ip';

export type ClientSubnetAction = 'ADD' | 'REMOVE' | 'REPLACE';

export const CLIENT_SUBNET_ACTIONS: readonly ClientSubnetAction[] = ['ADD', 'REMOVE', 'REPLACE'];

export interface ClientSubnetView {
  readonly name: string;
  readonly ipv4: readonly string[];
  readonly ipv6: readonly string[];
}

interface ClientSubnetRecord {
  readonly name: string;
  ipv4: string[];
  ipv6: string[];
}

export const CLIENT_SUBNET_REFUSALS = {
  missing: 'The client subnet does not exist on the DNS server.',
  existing: 'The client subnet already exists on the DNS server.',
  absentSubnet: 'The IP subnet specified does not exist in the client subnet.',
  presentSubnet: 'The IP subnet that is specified already exists in the client subnet.',
  lastAddress: 'Not allowed to remove all addresses.',
  invalid: 'The parameter is incorrect.',
} as const;

function subnetKey(text: string, v6: boolean): string | null {
  const length = cidrPrefixLength(text, v6);
  if (length === null) return null;
  const address = text.slice(0, text.lastIndexOf('/'));
  return `${v6 ? new IPv6Address(address).toString() : new IPAddress(address).toString()}/${length}`;
}

function distinctSubnets(texts: readonly string[], v6: boolean): string[] | null {
  const kept = new Map<string, string>();
  for (const text of texts) {
    const key = subnetKey(text.trim(), v6);
    if (key === null) return null;
    if (!kept.has(key)) kept.set(key, text.trim());
  }
  return [...kept.values()];
}

export class ClientSubnetStore {
  private readonly records = new Map<string, ClientSubnetRecord>();

  list(): ClientSubnetView[] {
    return [...this.records.values()].map(record => this.view(record));
  }

  find(name: string): ClientSubnetView | null {
    const record = this.records.get(name.toLowerCase());
    return record === undefined ? null : this.view(record);
  }

  create(name: string, ipv4: readonly string[], ipv6: readonly string[]): string | null {
    const key = name.toLowerCase();
    if (this.records.has(key)) return CLIENT_SUBNET_REFUSALS.existing;
    const four = distinctSubnets(ipv4, false);
    const six = distinctSubnets(ipv6, true);
    if (four === null || six === null) return CLIENT_SUBNET_REFUSALS.invalid;
    this.records.set(key, { name, ipv4: four, ipv6: six });
    return null;
  }

  remove(name: string): string | null {
    return this.records.delete(name.toLowerCase()) ? null : CLIENT_SUBNET_REFUSALS.missing;
  }

  change(name: string, action: ClientSubnetAction, ipv4: readonly string[], ipv6: readonly string[]): string | null {
    const record = this.records.get(name.toLowerCase());
    if (record === undefined) return CLIENT_SUBNET_REFUSALS.missing;
    const four = distinctSubnets(ipv4, false);
    const six = distinctSubnets(ipv6, true);
    if (four === null || six === null) return CLIENT_SUBNET_REFUSALS.invalid;
    switch (action) {
      case 'ADD': return this.add(record, four, six);
      case 'REMOVE': return this.subtract(record, four, six);
      case 'REPLACE': return this.replace(record, four, six);
    }
  }

  private add(record: ClientSubnetRecord, ipv4: string[], ipv6: string[]): string | null {
    if (this.overlap(record.ipv4, ipv4, false) || this.overlap(record.ipv6, ipv6, true)) return CLIENT_SUBNET_REFUSALS.presentSubnet;
    record.ipv4.push(...ipv4);
    record.ipv6.push(...ipv6);
    return null;
  }

  private subtract(record: ClientSubnetRecord, ipv4: string[], ipv6: string[]): string | null {
    const four = this.without(record.ipv4, ipv4, false);
    const six = this.without(record.ipv6, ipv6, true);
    if (four === null || six === null) return CLIENT_SUBNET_REFUSALS.absentSubnet;
    if (four.length + six.length === 0) return CLIENT_SUBNET_REFUSALS.lastAddress;
    record.ipv4 = four;
    record.ipv6 = six;
    return null;
  }

  private replace(record: ClientSubnetRecord, ipv4: string[], ipv6: string[]): string | null {
    if (ipv4.length + ipv6.length === 0) return CLIENT_SUBNET_REFUSALS.lastAddress;
    if (ipv4.length > 0) record.ipv4 = ipv4;
    if (ipv6.length > 0) record.ipv6 = ipv6;
    return null;
  }

  private overlap(held: readonly string[], given: readonly string[], v6: boolean): boolean {
    const keys = new Set(held.map(text => subnetKey(text, v6)));
    return given.some(text => keys.has(subnetKey(text, v6)));
  }

  private without(held: readonly string[], given: readonly string[], v6: boolean): string[] | null {
    const gone = new Set(given.map(text => subnetKey(text, v6)));
    const kept = held.filter(text => !gone.has(subnetKey(text, v6)));
    return held.length - kept.length === gone.size ? kept : null;
  }

  private view(record: ClientSubnetRecord): ClientSubnetView {
    return { name: record.name, ipv4: [...record.ipv4], ipv6: [...record.ipv6] };
  }
}

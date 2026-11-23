import type { RadSecTls } from './RadSecTlsPolicy';
import { IPAddress, SubnetMask } from '@/network/core/types';

export type MessageAuthenticatorPolicy = 'yes' | 'no' | 'auto';

export interface RadiusClientEntry {
  readonly name: string;
  readonly shortname: string;
  readonly section?: string;
  readonly confLines?: readonly string[];
  readonly address: IPAddress;
  readonly prefix: number;
  readonly secret: string;
  readonly nasType: string;
  readonly requireMessageAuthenticator: MessageAuthenticatorPolicy;
  readonly limitProxyState: MessageAuthenticatorPolicy;
  readonly protocol?: ClientProtocol;
  readonly tlsRequired?: boolean;
  readonly tls?: RadSecTls;
}

export type ClientProtocol = 'udp' | 'tcp' | '*';

export type ClientTransport = 'udp' | 'tcp' | 'tls';

export const protocolOf = (entry: RadiusClientEntry): ClientProtocol => entry.protocol ?? 'udp';

export class RadiusClientTable {
  private entries: RadiusClientEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries = [];
  }

  add(entry: RadiusClientEntry): boolean {
    const duplicate = this.entries.some(
      (known) => known.prefix === entry.prefix && known.address.toString() === entry.address.toString() && protocolOf(known) === protocolOf(entry),
    );
    if (duplicate) return false;
    this.entries.push(entry);
    this.entries.sort((a, b) => b.prefix - a.prefix);
    return true;
  }

  find(ip: IPAddress, transport: ClientTransport = 'udp'): RadiusClientEntry | null {
    for (const entry of this.entries) {
      const carried = transport === 'udp' ? 'udp' : 'tcp';
      if (protocolOf(entry) !== '*' && protocolOf(entry) !== carried) continue;
      if (entry.tlsRequired === true && transport !== 'tls') continue;
      if (entry.prefix === 0) return entry;
      const mask = SubnetMask.fromCIDR(entry.prefix);
      if (ip.isInSameSubnet(entry.address, mask)) return entry;
    }
    return null;
  }

  list(): readonly RadiusClientEntry[] {
    return this.entries;
  }
}

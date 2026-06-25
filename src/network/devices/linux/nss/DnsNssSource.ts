/**
 * DnsNssSource — the `dns` NSS source for hosts/ahosts lookups.
 *
 * With a wire resolver injected (the host's UDP/53 stub) and nameservers
 * configured in /etc/resolv.conf, lookups travel the cable plant like a
 * real stub resolver: NXDOMAIN is authoritative, all-servers-timeout
 * yields TRYAGAIN (EAI_AGAIN).
 *
 * Without nameservers (or without the injected resolver), falls back to
 * the legacy topology scan — the historic "the LAN graph is the DNS"
 * convenience kept for unconfigured boxes.
 */

import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { DnsWireResponse } from '../../../dns/DnsWire';
import type { INssSource } from './INssSource';
import { nssNotFound as NOTFOUND } from './nssResult';
import type { NssEnumResult, NssHostEntry, NssResult } from './types';

export interface DnsWireStubResolver {
  /** Usable `nameserver` entries from /etc/resolv.conf (loopback stubs excluded). */
  nameservers(): string[];
  query(serverIp: string, name: string, qtype: 'A' | 'AAAA' | 'PTR'): DnsWireResponse | null;
}

export class DnsNssSource implements INssSource {
  readonly name = 'dns';

  private wire: DnsWireStubResolver | null = null;

  setWireResolver(resolver: DnsWireStubResolver | null): void {
    this.wire = resolver;
  }

  gethostbyname(name: string, family?: 2 | 10): NssResult<NssHostEntry[]> {
    const servers = this.wire?.nameservers() ?? [];
    if (this.wire && servers.length > 0) {
      return this.wireLookup(servers, name, family);
    }
    return this.legacyScanByName(name, family);
  }

  gethostbyaddr(addr: string): NssResult<NssHostEntry> {
    const servers = this.wire?.nameservers() ?? [];
    if (this.wire && servers.length > 0) {
      return this.wirePtrLookup(servers, addr);
    }
    return this.legacyScanByAddr(addr);
  }

  /**
   * `dns` has no enumeration semantics on real Linux (you cannot dump
   * the entire DNS world). Returning UNAVAIL lets the resolver fall
   * through to the next source for `getent hosts` with no key.
   */
  enumHosts(): NssEnumResult<NssHostEntry> {
    return { status: 'UNAVAIL', entries: [] };
  }

  // ─── Wire path ────────────────────────────────────────────────────

  private queryAny(
    servers: string[], name: string, qtype: 'A' | 'AAAA' | 'PTR',
  ): DnsWireResponse | null {
    for (const server of servers) {
      const resp = this.wire!.query(server, name, qtype);
      if (resp) return resp;
    }
    return null;
  }

  private wireLookup(
    servers: string[], name: string, family?: 2 | 10,
  ): NssResult<NssHostEntry[]> {
    const qtypes: Array<'A' | 'AAAA'> =
      family === 10 ? ['AAAA'] : family === 2 ? ['A'] : ['A', 'AAAA'];
    const matches: NssHostEntry[] = [];
    let answered = false;

    for (const qtype of qtypes) {
      const resp = this.queryAny(servers, name, qtype);
      if (!resp) continue;
      answered = true;
      if (resp.rcode === 'NXDOMAIN') return NOTFOUND();
      if (resp.rcode !== 'NOERROR') return { status: 'TRYAGAIN' };
      for (const answer of resp.answers) {
        if (answer.type !== qtype) continue;
        matches.push({
          canonicalName: resp.name.toLowerCase(),
          addressFamily: qtype === 'AAAA' ? 10 : 2,
          address: answer.value,
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
    if (resp.rcode !== 'NOERROR' || resp.answers.length === 0) return NOTFOUND();
    const ptr = resp.answers.find(a => a.type === 'PTR');
    if (!ptr) return NOTFOUND();
    return {
      status: 'SUCCESS',
      entry: {
        canonicalName: ptr.value,
        addressFamily: addr.includes(':') ? 10 : 2,
        address: addr,
        aliases: [],
      },
    };
  }

  // ─── Legacy topology scan (no nameserver configured) ─────────────

  private legacyScanByName(name: string, family?: 2 | 10): NssResult<NssHostEntry[]> {
    const needle = name.toLowerCase();
    const short = needle.split('.')[0];
    const matches: NssHostEntry[] = [];

    for (const dev of EquipmentRegistry.getInstance().getAll()) {
      if (!dev.getIsPoweredOn()) continue;
      const hostname = dev.getHostname?.()?.toLowerCase();
      if (!hostname) continue;
      if (hostname !== needle && hostname !== short) continue;

      for (const port of dev.getPorts()) {
        const ip = port.getIPAddress();
        if (!ip) continue;
        const ipStr = ip.toString();
        const af: 2 | 10 = ipStr.includes(':') ? 10 : 2;
        if (family && af !== family) continue;
        matches.push({
          canonicalName: hostname,
          addressFamily: af,
          address: ipStr,
          aliases: hostname === needle ? [] : [needle],
        });
      }
    }

    if (matches.length) return { status: 'SUCCESS', entry: matches };
    return NOTFOUND();
  }

  private legacyScanByAddr(addr: string): NssResult<NssHostEntry> {
    for (const dev of EquipmentRegistry.getInstance().getAll()) {
      if (!dev.getIsPoweredOn()) continue;
      const hostname = dev.getHostname?.();
      if (!hostname) continue;
      for (const port of dev.getPorts()) {
        const ip = port.getIPAddress();
        if (!ip) continue;
        if (ip.toString() === addr) {
          return {
            status: 'SUCCESS',
            entry: {
              canonicalName: hostname,
              addressFamily: addr.includes(':') ? 10 : 2,
              address: addr,
              aliases: [],
            },
          };
        }
      }
    }
    return NOTFOUND();
  }
}

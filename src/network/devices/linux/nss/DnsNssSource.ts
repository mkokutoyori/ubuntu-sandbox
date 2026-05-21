/**
 * DnsNssSource — the `dns` NSS source for hosts/ahosts lookups.
 *
 * Bridges NSS to the simulator's topology: walks the EquipmentRegistry
 * to translate a hostname into the IP(s) configured on the matching
 * device. This mirrors a real resolver that would send a query to a
 * recursive resolver — except here the "DNS" is the in-process
 * topology graph (faithful to a LAN simulation where the SOHO router
 * runs dnsmasq and the address space is local).
 *
 * Faithful behaviour:
 *   - returns SUCCESS only for hostnames that resolve to *powered-on*
 *     devices — a powered-off host is mapped to NOTFOUND so `getent
 *     hosts pc2` after `pc2.powerOff()` mirrors the real "no answer".
 *   - aliases (multiple hostnames on the same device, e.g. via short
 *     name + FQDN) are kept in the alias list.
 *   - addressFamily is set per IP version.
 *
 * Not implemented (yet — left for future expansion when MX, SRV, TXT
 * records land on a real DNS server in the topology):
 *   - reverse lookup (`gethostbyaddr`) — fall through to UNAVAIL so the
 *     resolver tries the next source.
 *   - recursive lookups via a remote DNS server.
 */

import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { INssSource } from './INssSource';
import type { NssEnumResult, NssHostEntry, NssResult } from './types';

const NOTFOUND = <T>(): NssResult<T> => ({ status: 'NOTFOUND' });
const UNAVAIL = <T>(): NssResult<T> => ({ status: 'UNAVAIL' });

export class DnsNssSource implements INssSource {
  readonly name = 'dns';

  gethostbyname(name: string, family?: 2 | 10): NssResult<NssHostEntry[]> {
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

  gethostbyaddr(addr: string): NssResult<NssHostEntry> {
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

  /**
   * `dns` has no enumeration semantics on real Linux (you cannot dump
   * the entire DNS world). Returning UNAVAIL lets the resolver fall
   * through to the next source for `getent hosts` with no key.
   */
  enumHosts(): NssEnumResult<NssHostEntry> {
    return { status: 'UNAVAIL', entries: [] };
  }
}

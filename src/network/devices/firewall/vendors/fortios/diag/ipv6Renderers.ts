import type { Port } from '../../../../../hardware/Port';
import type {
  IPv6RouteEntry, NeighborCacheEntry,
} from '../../../../router/IPv6DataPlane';

export function renderIpv6AddressList(ports: readonly Port[]): string {
  const lines: string[] = [];
  for (const port of ports) {
    for (const entry of port.getIPv6Addresses()) {
      lines.push(`dev=${port.getName()} devname=${port.getName()} `
        + `ip6=${entry.address}/${entry.prefixLength}`);
    }
  }
  return lines.join('\n');
}

export function renderIpv6NeighborCache(
  entries: ReadonlyMap<string, NeighborCacheEntry>,
): string {
  const lines: string[] = [];
  let index = 0;
  for (const [address, entry] of entries) {
    lines.push(`ndp entry ${index++}: ${address} `
      + `dev=${entry.iface} mac=${entry.mac} state=${entry.state}`);
  }
  return lines.join('\n');
}

const ROUTE_CODES: Readonly<Record<string, string>> = Object.freeze({
  connected: 'C', static: 'S', default: 'S*',
});

export function renderIpv6RoutingTable(routes: readonly IPv6RouteEntry[]): string {
  const lines = [
    'Codes: K - kernel route, C - connected, S - static, R - RIPng, O - OSPFv3,',
    '       I - IS-IS, B - BGP',
    '',
  ];
  for (const route of routes) {
    const code = ROUTE_CODES[route.type] ?? 'S';
    const prefix = `${route.prefix}/${route.prefixLength}`;
    lines.push(route.nextHop
      ? `${code}   ${prefix} [${route.ad}/${route.metric}] via ${route.nextHop}, ${route.iface}`
      : `${code}   ${prefix} [${route.ad}/${route.metric}] is directly connected, ${route.iface}`);
  }
  return lines.join('\n');
}

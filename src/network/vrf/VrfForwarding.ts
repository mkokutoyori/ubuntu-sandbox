import { IPAddress, SubnetMask } from '@/network/core/types';
import type { MplsLabel } from '@/network/mpls/MplsLabel';

export interface VrfVpnAttributes {
  readonly label: MplsLabel;
  readonly bgpNextHop: IPAddress;
}

export interface VrfRoute {
  readonly network: IPAddress;
  readonly mask: SubnetMask;
  readonly nextHop: IPAddress | null;
  readonly iface: string;
  readonly type: 'connected' | 'static' | 'bgp';
  readonly ad: number;
  readonly metric: number;
  readonly vpn?: VrfVpnAttributes;
}

export interface VrfMemberAddress {
  readonly iface: string;
  readonly address: IPAddress;
  readonly mask: SubnetMask;
}

export interface VrfStaticRouteConfig {
  readonly network: string;
  readonly mask: string;
  readonly nextHop: string | null;
  readonly iface: string | null;
}

export interface VrfRouteSources {
  memberAddresses(vrf: string): readonly VrfMemberAddress[];
  staticRoutes(vrf: string): readonly VrfStaticRouteConfig[];
  importedRoutes(vrf: string): readonly VrfRoute[];
  interfaceUsable(iface: string): boolean;
}

export const CONNECTED_DISTANCE = 0;
export const STATIC_DISTANCE = 1;

function contains(network: IPAddress, mask: SubnetMask, destination: IPAddress): boolean {
  return (destination.toUint32() & mask.toUint32()) === (network.toUint32() & mask.toUint32());
}

function connectedRoutes(members: readonly VrfMemberAddress[]): VrfRoute[] {
  return members.map(member => ({
    network: member.address.networkAddress(member.mask), mask: member.mask, nextHop: null, iface: member.iface,
    type: 'connected' as const, ad: CONNECTED_DISTANCE, metric: 0,
  }));
}

function staticRoute(config: VrfStaticRouteConfig, members: readonly VrfMemberAddress[]): VrfRoute | null {
  const network = IPAddress.tryParse(config.network);
  if (network === null) return null;
  let mask: SubnetMask;
  try { mask = new SubnetMask(config.mask); } catch { return null; }
  const nextHop = config.nextHop === null ? null : IPAddress.tryParse(config.nextHop);
  if (config.nextHop !== null && nextHop === null) return null;
  let iface = config.iface;
  if (iface === null && nextHop !== null) {
    iface = members.find(member => contains(member.address.networkAddress(member.mask), member.mask, nextHop))?.iface ?? null;
  }
  if (iface === null) return null;
  return { network, mask, nextHop, iface, type: 'static', ad: STATIC_DISTANCE, metric: 0 };
}

export function vrfRoutes(vrf: string, sources: VrfRouteSources): VrfRoute[] {
  const members = sources.memberAddresses(vrf);
  const statics = sources.staticRoutes(vrf).flatMap(config => { const route = staticRoute(config, members); return route ? [route] : []; });
  return [...connectedRoutes(members), ...statics, ...sources.importedRoutes(vrf)]
    .filter(route => sources.interfaceUsable(route.iface) || route.vpn !== undefined);
}

export function lookupVrfRoute(vrf: string, destination: IPAddress, sources: VrfRouteSources): VrfRoute | null {
  let best: VrfRoute | null = null;
  for (const route of vrfRoutes(vrf, sources)) {
    if (!contains(route.network, route.mask, destination)) continue;
    if (best === null) { best = route; continue; }
    const length = route.mask.toCIDR();
    const bestLength = best.mask.toCIDR();
    if (length > bestLength || (length === bestLength && (route.ad < best.ad || (route.ad === best.ad && route.metric < best.metric)))) best = route;
  }
  return best;
}

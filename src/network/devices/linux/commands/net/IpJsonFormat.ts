import type { IpInterfaceInfo, IpRouteEntry, IpNeighborEntry, IpFamily } from '../../LinuxIpCommand';

export interface JsonAddrInfoEntry {
  family: 'inet' | 'inet6';
  local: string;
  prefixlen: number;
  broadcast?: string;
  scope: string;
  dynamic?: boolean;
  label?: string;
  valid_life_time: number;
  preferred_life_time: number;
}

export interface JsonStats64 {
  rx: { bytes: number; packets: number; errors: number; dropped: number; over_errors: number; multicast: number };
  tx: { bytes: number; packets: number; errors: number; dropped: number; carrier_errors: number; collisions: number };
}

export interface JsonLinkEntry {
  ifindex: number;
  ifname: string;
  flags: string[];
  mtu: number;
  qdisc: string;
  operstate: string;
  linkmode: string;
  group: string;
  txqlen: number;
  link_type: string;
  address: string;
  broadcast: string;
  stats64?: JsonStats64;
}

export interface JsonAddrEntry extends JsonLinkEntry {
  addr_info: JsonAddrInfoEntry[];
}

export interface JsonRouteEntry {
  dst: string;
  gateway?: string;
  dev: string;
  protocol: string;
  scope?: string;
  prefsrc?: string;
  metric?: number;
  flags: string[];
}

export interface JsonNeighEntry {
  dst: string;
  dev: string;
  lladdr?: string;
  state: string[];
}

const FOREVER = 4294967295;

function stats64(info: IpInterfaceInfo): JsonStats64 {
  const c = info.counters;
  return {
    rx: {
      bytes: c.bytesIn, packets: c.framesIn,
      errors: c.errorsIn ?? 0, dropped: 0, over_errors: 0, multicast: 0,
    },
    tx: {
      bytes: c.bytesOut, packets: c.framesOut,
      errors: c.errorsOut ?? 0, dropped: 0, carrier_errors: 0, collisions: 0,
    },
  };
}

export function buildLinkJsonEntry(info: IpInterfaceInfo, ifindex: number, flags: string[], includeStats: boolean): JsonLinkEntry {
  const isLoopback = info.name === 'lo';
  const state = info.isUp && info.isConnected ? 'UP' : 'DOWN';
  const entry: JsonLinkEntry = {
    ifindex,
    ifname: info.name,
    flags,
    mtu: info.mtu,
    qdisc: isLoopback ? 'noqueue' : 'fq_codel',
    operstate: state,
    linkmode: 'DEFAULT',
    group: 'default',
    txqlen: isLoopback ? 0 : 1000,
    link_type: isLoopback ? 'loopback' : 'ether',
    address: info.mac,
    broadcast: isLoopback ? '00:00:00:00:00:00' : 'ff:ff:ff:ff:ff:ff',
  };
  if (includeStats) entry.stats64 = stats64(info);
  return entry;
}

export function buildAddrJsonEntry(
  info: IpInterfaceInfo, ifindex: number, flags: string[], family: IpFamily, includeStats: boolean,
): JsonAddrEntry {
  const isLoopback = info.name === 'lo';
  const link = buildLinkJsonEntry(info, ifindex, flags, includeStats);
  const addrInfo: JsonAddrInfoEntry[] = [];

  if (family !== 'inet6' && info.ip && info.cidr !== null) {
    addrInfo.push({
      family: 'inet',
      local: info.ip,
      prefixlen: info.cidr,
      scope: isLoopback ? 'host' : 'global',
      dynamic: info.isDHCP || undefined,
      label: info.name,
      valid_life_time: FOREVER,
      preferred_life_time: FOREVER,
    });
    for (const sec of info.secondaryIPs ?? []) {
      addrInfo.push({
        family: 'inet',
        local: sec.ip,
        prefixlen: sec.cidr,
        scope: isLoopback ? 'host' : 'global',
        label: info.name,
        valid_life_time: FOREVER,
        preferred_life_time: FOREVER,
      });
    }
  }

  if (family !== 'inet') {
    for (const v6 of info.ipv6 ?? []) {
      addrInfo.push({
        family: 'inet6',
        local: v6.address,
        prefixlen: v6.prefixLength,
        scope: v6.scope,
        valid_life_time: FOREVER,
        preferred_life_time: FOREVER,
      });
    }
  }

  return { ...link, addr_info: addrInfo };
}

export function buildRouteJsonEntry(route: IpRouteEntry): JsonRouteEntry {
  const entry: JsonRouteEntry = {
    dst: route.type === 'default' ? 'default' : `${route.network}/${route.cidr}`,
    dev: route.iface,
    protocol: route.type === 'connected' ? 'kernel' : (route.isDHCP ? 'dhcp' : 'static'),
    flags: [],
  };
  if (route.nextHop) entry.gateway = route.nextHop;
  if (route.type === 'connected') entry.scope = 'link';
  if (route.srcIp) entry.prefsrc = route.srcIp;
  if (route.metric > 0) entry.metric = route.metric;
  return entry;
}

export function buildNeighJsonEntry(n: IpNeighborEntry): JsonNeighEntry {
  const entry: JsonNeighEntry = {
    dst: n.ip,
    dev: n.iface,
    state: [n.state],
  };
  if (n.mac) entry.lladdr = n.mac;
  return entry;
}

export function toJsonText(data: unknown[], pretty: boolean): string {
  return pretty ? JSON.stringify(data, null, 4) : JSON.stringify(data);
}

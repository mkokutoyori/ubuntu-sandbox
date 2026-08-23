import { ospfRouteCode } from '@/network/ospf/routeCodes';
import { cpuStatesLines, memoryLine } from './systemLoad';
import type { SystemLoad } from '../../../health/SystemLoad';
import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';
import type { InterfaceTable } from '../../../l3/InterfaceTable';
import type { FirewallRoute, RouteTable } from '../../../l3/RouteTable';
import type { ArpService } from '../../../l3/ArpService';
import type { SecurityRule } from '../../../model/SecurityRule';
import type { BgpSummaryFacts } from '../../../routing/DynamicRoutingTypes';

export interface SystemStatusFacts {
  readonly version: string;
  readonly build: string;
  readonly serial: string;
  readonly hostname: string;
  readonly operationMode: string;
  readonly vdom: string;
  readonly maxVdoms: number;
  readonly vdomsInNat: number;
  readonly vdomsInTransparent: number;
  readonly vdomConfiguration: string;
  readonly haMode: string;
  readonly licenseStatus: string;
  readonly vmCpus: number;
  readonly vmMemoryMb: number;
  readonly logDisk: string;
  readonly systemTime: string;
}

export function renderSystemStatus(facts: SystemStatusFacts): string {
  return [
    `Version: FortiGate-VM64 v${facts.version},build${facts.build}`,
    `Serial-Number: ${facts.serial}`,
    `License Status: ${facts.licenseStatus}`,
    `VM Resources: ${facts.vmCpus} CPU, ${facts.vmMemoryMb} MB RAM`,
    `Log hard disk: ${facts.logDisk}`,
    `Hostname: ${facts.hostname}`,
    `Operation Mode: ${facts.operationMode}`,
    `Current virtual domain: ${facts.vdom}`,
    `Max number of virtual domains: ${facts.maxVdoms}`,
    `Virtual domains status: ${facts.vdomsInNat} in NAT mode,`
    + ` ${facts.vdomsInTransparent} in TP mode`,
    `Virtual domain configuration: ${facts.vdomConfiguration}`,
    `Current HA mode: ${facts.haMode}`,
    `Branch point: ${facts.build}`,
    `System time: ${facts.systemTime}`,
  ].join('\n');
}

export interface PerformanceFacts {
  readonly load: SystemLoad;
  readonly uptimeMs: number;
}

const AVERAGE_WINDOWS: readonly number[] = Object.freeze([1, 10, 30]);

function windowLabel(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

export function renderPerformanceStatus(facts: PerformanceFacts): string {
  const seconds = Math.floor(facts.uptimeMs / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const load = facts.load;

  const networkUsage = AVERAGE_WINDOWS.map((window) => {
    const kbps = load.averageKbps(window);
    return `${kbps.inbound} / ${kbps.outbound} kbps in ${windowLabel(window)}`;
  }).join(', ');
  const sessions = AVERAGE_WINDOWS.map((window) =>
    `${load.averageSessions(window)} sessions in ${windowLabel(window)}`).join(', ');
  const setupRate = AVERAGE_WINDOWS.map((window) =>
    `${load.averageSetupRate(window)} sessions per second in last `
    + `${windowLabel(window)}`).join(', ');

  return [
    ...cpuStatesLines(load),
    memoryLine(load.memory()),
    `Average network usage: ${networkUsage}`,
    `Average sessions: ${sessions}`,
    `Average session setup rate: ${setupRate}`,
    `Virus caught: 0 total in 1 minute`,
    `IPS attacks blocked: 0 total in 1 minute`,
    `Uptime: ${days} days, ${hours} hours, ${minutes} minutes`,
  ].join('\n');
}

export interface InterfaceStatusFacts {
  readonly name: string;
  readonly mode: string;
  readonly ip: string;
  readonly ipv6: string;
  readonly status: string;
  readonly speed: string;
  readonly physical: boolean;
}

export function renderInterfaceStatus(
  facts: readonly InterfaceStatusFacts[], physicalOnly: boolean,
): string {
  const lines: string[] = [];
  for (const iface of facts) {
    if (physicalOnly && !iface.physical) continue;
    lines.push(`== [${iface.name}]`);
    lines.push(`\tmode: ${iface.mode}`);
    lines.push(`\tip: ${iface.ip}`);
    lines.push(`\tipv6: ${iface.ipv6}`);
    lines.push(`\tstatus: ${iface.status}`);
    lines.push(`\tspeed: ${iface.speed}`);
  }
  return lines.join('\n');
}

export function renderArpTable(arp: ArpService): string {
  const rows = [...arp.getCache().entries()].map(([address, entry]) => ({
    address,
    age: '0',
    mac: entry.mac.toString(),
    iface: entry.iface,
  }));

  return renderTable(rows, [
    { header: 'Address', width: 18, value: row => row.address },
    { header: 'Age(min)', width: 10, value: row => row.age },
    { header: 'Hardware Addr', width: 20, value: row => row.mac },
    { header: 'Interface', width: 0, value: row => row.iface },
  ], FIXED_TABLE).join('\n');
}

const ROUTE_CODE: Readonly<Record<string, string>> = Object.freeze({
  connected: 'C',
  static: 'S',
  default: 'S*',
  dynamic: 'O',
});

const PROTOCOL_CODE: Readonly<Record<string, string>> = Object.freeze({
  rip: 'R',
  ospf: 'O',
  bgp: 'B',
});

function prefixLength(mask: string): number {
  return mask.split('.')
    .map(octet => Number.parseInt(octet, 10).toString(2).split('1').length - 1)
    .reduce((total, bits) => total + bits, 0);
}

export type RoutingView = 'all' | 'static' | 'connected' | 'database'
  | 'ospf' | 'rip' | 'bgp';

export function renderRoutingTable(routes: RouteTable, view: RoutingView): string {
  if (view === 'database') return renderRoutingDatabase(routes);

  const lines = [
    'Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP',
    '       O - OSPF, IA - OSPF inter area',
    '       * - candidate default',
    '',
  ];

  const rows = routes.selected()
    .filter(route => keptBy(view, route))
    .map(route => ({
      code: routeCode(route),
      destination: `${route.network}/${prefixLength(route.mask)} ${reachedBy(route)}`,
    }));

  lines.push(...renderTable(rows, [
    { header: '', width: 8, value: row => row.code },
    { header: '', width: 0, value: row => row.destination },
  ], FIXED_TABLE).filter(line => line.trim().length > 0));

  return lines.join('\n');
}

export function renderRoutingDatabase(routes: RouteTable): string {
  const lines = [
    'Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP',
    '       O - OSPF, IA - OSPF inter area',
    '       > - selected route, * - FIB route',
    '',
  ];

  for (const route of routes.all()) {
    const kept = routes.isSelected(route);
    lines.push(`${protocolLetter(route).padEnd(5)}${kept ? '*>' : '  '} `
      + `${route.network}/${prefixLength(route.mask)} ${reachedBy(route)}`
      + (kept ? '' : ' inactive'));
  }
  return lines.join('\n');
}

function keptBy(view: RoutingView, route: FirewallRoute): boolean {
  if (view === 'static') return route.kind === 'static' || route.kind === 'default';
  if (view === 'connected') return route.kind === 'connected';
  if (view === 'ospf' || view === 'rip' || view === 'bgp') {
    return protocolLetter(route).toLowerCase().startsWith(view[0]);
  }
  return true;
}

function protocolLetter(route: FirewallRoute): string {
  return routeCode(route).replace('*', '').trim();
}

function routeCode(route: FirewallRoute): string {
  if (route.protocol === 'ospf') {
    return ospfRouteCode(route.routeType, isDefaultRoute(route)).trimEnd();
  }
  return (route.protocol === undefined
    ? ROUTE_CODE[route.kind]
    : PROTOCOL_CODE[route.protocol]) ?? 'S';
}

function isDefaultRoute(route: FirewallRoute): boolean {
  return route.network === '0.0.0.0' && route.mask === '0.0.0.0';
}

function reachedBy(route: FirewallRoute): string {
  const metric = `[${route.distance}/${route.metric ?? 0}]`;
  const onLink = route.nextHop === undefined
    || route.nextHop.length === 0
    || route.nextHop === route.network;
  if (onLink) {
    return route.kind === 'connected'
      ? `is directly connected, ${route.iface}`
      : `${metric} is directly connected, ${route.iface}`;
  }
  return `${metric} via ${route.nextHop}, ${route.iface}`;
}

export function renderOspfNeighbors(
  neighbours: ReadonlyArray<{
    routerId: string; priority: number; state: string; address: string; iface: string;
  }>,
): string {
  const header = 'OSPF process 1:\nNeighbor ID     Pri State           '
    + 'Dead Time   Address         Interface';
  if (neighbours.length === 0) return header;

  const rows = neighbours.map(entry => ({
    id: entry.routerId,
    pri: String(entry.priority),
    state: entry.state,
    dead: '00:00:38',
    address: entry.address,
    iface: entry.iface,
  }));

  return [header, ...renderTable(rows, [
    { header: '', width: 16, value: row => row.id },
    { header: '', width: 4, value: row => row.pri },
    { header: '', width: 16, value: row => row.state },
    { header: '', width: 12, value: row => row.dead },
    { header: '', width: 16, value: row => row.address },
    { header: '', width: 0, value: row => row.iface },
  ], FIXED_TABLE)].join('\n');
}


export function renderBgpSummary(facts: BgpSummaryFacts): string {
  const lines = [
    `BGP router identifier ${facts.routerId}, local AS number ${facts.localAs}`,
    '',
  ];

  const rows = facts.neighbours.map(peer => ({
    address: peer.address,
    version: '4',
    remoteAs: String(peer.remoteAs),
    received: '0',
    sent: '0',
    tableVersion: '0',
    inQueue: '0',
    outQueue: '0',
    upDown: peer.isUp ? uptimeClock(peer.uptimeSec) : 'never',
    state: peer.isUp ? String(peer.prefixesReceived) : peer.state,
  }));

  lines.push(...renderTable(rows, [
    { header: 'Neighbor', width: 16, value: row => row.address },
    { header: 'V', width: 1, value: row => row.version },
    { header: 'AS', width: 11, align: 'right', value: row => row.remoteAs },
    { header: 'MsgRcvd', width: 8, align: 'right', value: row => row.received },
    { header: 'MsgSent', width: 8, align: 'right', value: row => row.sent },
    { header: 'TblVer', width: 9, align: 'right', value: row => row.tableVersion },
    { header: 'InQ', width: 5, align: 'right', value: row => row.inQueue },
    { header: 'OutQ', width: 5, align: 'right', value: row => row.outQueue },
    { header: 'Up/Down', width: 9, align: 'right', value: row => row.upDown },
    { header: 'State/PfxRcd', width: 13, align: 'right', value: row => row.state },
  ], FIXED_TABLE));

  lines.push('', `Total number of neighbors ${facts.neighbours.length}`);
  return lines.join('\n');
}

export function renderBgpNeighbors(facts: BgpSummaryFacts): string {
  if (facts.neighbours.length === 0) return 'No BGP neighbors configured.';

  const lines: string[] = [];
  for (const peer of facts.neighbours) {
    lines.push(
      `BGP neighbor is ${peer.address}, remote AS ${peer.remoteAs},`
      + ` local AS ${facts.localAs}, ${peer.remoteAs === facts.localAs ? 'internal' : 'external'} link`,
      `  BGP state = ${peer.state}${peer.isUp ? `, up for ${uptimeClock(peer.uptimeSec)}` : ''}`,
      `  Local router ID ${facts.routerId}`,
      '',
    );
  }
  return lines.join('\n').trimEnd();
}

function uptimeClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(total / 3600)).padStart(2, '0');
  const mm = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export function renderDhcpLeases(
  leases: ReadonlyArray<{
    iface: string; ip: string; mac: string; expiresAt: number; serverId: string;
  }>,
): string {
  if (leases.length === 0) return '';

  const byInterface = new Map<string, typeof leases[number][]>();
  for (const lease of leases) {
    const bucket = byInterface.get(lease.iface) ?? [];
    bucket.push(lease);
    byInterface.set(lease.iface, bucket);
  }

  const lines: string[] = [];
  for (const [iface, bucket] of byInterface) {
    lines.push(iface);
    const rows = bucket.map(lease => ({
      ip: lease.ip,
      mac: lease.mac,
      hostname: '',
      vci: '',
      serverId: lease.serverId,
      expiry: new Date(lease.expiresAt).toUTCString(),
    }));
    lines.push(...renderTable(rows, [
      { header: 'IP', width: 16, value: row => row.ip },
      { header: 'MAC-Address', width: 19, value: row => row.mac },
      { header: 'Hostname', width: 19, value: row => row.hostname },
      { header: 'VCI', width: 17, value: row => row.vci },
      { header: 'SERVER-ID', width: 10, value: row => row.serverId },
      { header: 'Expiry', width: 0, value: row => row.expiry },
    ], FIXED_TABLE).map(line => `    ${line}`));
  }
  return lines.join('\n');
}

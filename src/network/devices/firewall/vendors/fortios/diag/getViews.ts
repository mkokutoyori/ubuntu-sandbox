import { renderTable, FIXED_TABLE } from '../../../../shells/cli/TextTable';
import type { InterfaceTable } from '../../../l3/InterfaceTable';
import type { RouteTable } from '../../../l3/RouteTable';
import type { ArpService } from '../../../l3/ArpService';
import type { SecurityRule } from '../../../model/SecurityRule';
import type { SessionStatistics } from '../../../session/SessionTable';

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
  readonly systemTime: string;
}

export function renderSystemStatus(facts: SystemStatusFacts): string {
  return [
    `Version: FortiGate-VM64 v${facts.version},build${facts.build}`,
    `Serial-Number: ${facts.serial}`,
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
  readonly sessions: SessionStatistics;
  readonly uptimeMs: number;
}

export function renderPerformanceStatus(facts: PerformanceFacts): string {
  const seconds = Math.floor(facts.uptimeMs / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);

  return [
    `Current sessions: ${facts.sessions.active}`,
    `Total sessions created: ${facts.sessions.created}`,
    `Total sessions closed: ${facts.sessions.closed}`,
    `Uptime: ${days} days, ${hours} hours, ${minutes} minutes`,
  ].join('\n');
}

export function renderInterfaceStatus(interfaces: InterfaceTable): string {
  const rows = interfaces.all().map(iface => ({
    name: iface.name,
    address: iface.ip === undefined ? '0.0.0.0 0.0.0.0' : `${iface.ip} ${iface.mask ?? ''}`,
    status: iface.up ? 'up' : 'down',
    mtu: String(iface.mtu),
  }));

  return renderTable(rows, [
    { header: 'name', width: 18, value: row => row.name },
    { header: 'ip', width: 34, value: row => row.address },
    { header: 'status', width: 8, value: row => row.status },
    { header: 'mtu', width: 0, value: row => row.mtu },
  ], FIXED_TABLE).join('\n');
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

export function renderRoutingTable(routes: RouteTable): string {
  const lines = [
    'Codes: K - kernel, C - connected, S - static, R - RIP, B - BGP',
    '       O - OSPF, IA - OSPF inter area',
    '       * - candidate default',
    '',
  ];

  for (const route of routes.all()) {
    const code = ROUTE_CODE[route.kind] ?? 'S';
    const prefix = `${route.network} ${route.mask}`;
    const via = route.nextHop === undefined
      ? `is directly connected, ${route.iface}`
      : `[${route.distance}/${route.metric ?? 0}] via ${route.nextHop}, ${route.iface}`;
    lines.push(`${code}       ${prefix} ${via}`);
  }
  return lines.join('\n');
}

export function renderFirewallPolicy(rules: readonly SecurityRule[]): string {
  const lines: string[] = [];
  for (const rule of rules) {
    lines.push(
      `policyid: ${rule.id}`,
      `name: ${rule.name ?? ''}`,
      `srcintf: ${rule.from.join(' ')}`,
      `dstintf: ${rule.to.join(' ')}`,
      `srcaddr: ${rule.source.join(' ')}`,
      `dstaddr: ${rule.destination.join(' ')}`,
      `service: ${rule.service.join(' ')}`,
      `action: ${rule.action}`,
      `status: ${rule.enabled ? 'enable' : 'disable'}`,
      `nat: ${rule.natEnabled ? 'enable' : 'disable'}`,
      `hit count: ${rule.hitCount}`,
      `bytes: ${rule.byteCount}`,
      '',
    );
  }
  return lines.join('\n').trimEnd();
}

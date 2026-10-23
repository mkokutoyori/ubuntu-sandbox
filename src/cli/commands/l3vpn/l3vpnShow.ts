import { padToWidth } from '@/network/devices/shells/cli/TextTable';
import { ciscoShortInterfaceName } from '@/network/devices/shells/cisco/CiscoCommonShow';

export interface VrfView {
  readonly name: string;
  readonly rd: string | null;
  readonly tableId: number;
  readonly importRts: readonly string[];
  readonly exportRts: readonly string[];
  readonly interfaces: ReadonlyArray<{ readonly name: string; readonly address: string | null; readonly up: boolean }>;
}

const SIMPLE_HEADER = '  Name                             Default RD            Interfaces';

export function formatIpVrfBrief(vrfs: readonly VrfView[]): string {
  if (vrfs.length === 0) return '';
  const lines = [SIMPLE_HEADER];
  for (const vrf of vrfs) {
    const names = vrf.interfaces.map(iface => ciscoShortInterfaceName(iface.name));
    lines.push(`  ${padToWidth(vrf.name, 33)}${padToWidth(vrf.rd ?? '<not set>', 22)}${names[0] ?? ''}`.trimEnd());
    for (const name of names.slice(1)) lines.push(`${' '.repeat(57)}${name}`);
  }
  return lines.join('\n');
}

export function formatVrfBrief(vrfs: readonly VrfView[]): string {
  if (vrfs.length === 0) return '';
  const lines = ['  Name                             Default RD            Protocols   Interfaces'];
  for (const vrf of vrfs) {
    const names = vrf.interfaces.map(iface => ciscoShortInterfaceName(iface.name));
    lines.push(`  ${padToWidth(vrf.name, 33)}${padToWidth(vrf.rd ?? '<not set>', 22)}${padToWidth('ipv4', 12)}${names[0] ?? ''}`.trimEnd());
    for (const name of names.slice(1)) lines.push(`${' '.repeat(69)}${name}`);
  }
  return lines.join('\n');
}

function communities(label: 'Export' | 'Import', rts: readonly string[], indent: string): string[] {
  return rts.length === 0
    ? [`${indent}No ${label} VPN route-target communities`]
    : [`${indent}${label} VPN route-target communities`, `${indent}  ${rts.map(rt => `RT:${rt}`).join(' ')}`];
}

export function formatIpVrfDetail(vrfs: readonly VrfView[]): string {
  return vrfs.map(vrf => [
    `VRF ${vrf.name}; default RD ${vrf.rd ?? '<not set>'}; default VPNID <not set>`,
    `  VRF Table ID = ${vrf.tableId}`,
    ...(vrf.interfaces.length === 0 ? [] : ['  Interfaces:', `    ${vrf.interfaces.map(iface => ciscoShortInterfaceName(iface.name)).join(' ')}`]),
    '  Connected addresses are not in global routing table',
    ...communities('Export', vrf.exportRts, '  '),
    ...communities('Import', vrf.importRts, '  '),
    '  No import route-map',
    '  No export route-map',
    '  VRF label distribution protocol: not configured',
    '  VRF label allocation mode: per-prefix',
  ].join('\n')).join('\n');
}

export function formatVrfDetail(vrfs: readonly VrfView[]): string {
  return vrfs.map(vrf => [
    `VRF ${vrf.name}; default RD ${vrf.rd ?? '<not set>'}; default VPNID <not set>`,
    ...(vrf.interfaces.length === 0 ? [] : ['  Interfaces:', `    ${vrf.interfaces.map(iface => ciscoShortInterfaceName(iface.name)).join(' ')}`]),
    `Address family ipv4 (Table ID = 0x${vrf.tableId.toString(16)}):`,
    '  Connected addresses are not in global routing table',
    ...communities('Export', vrf.exportRts, '  '),
    ...communities('Import', vrf.importRts, '  '),
    '  No import route-map',
    '  No export route-map',
    '  VRF label distribution protocol: not configured',
  ].join('\n')).join('\n');
}

export function formatIpVrfInterfaces(vrfs: readonly VrfView[]): string {
  const lines = ['Interface              IP-Address      VRF                              Protocol'];
  for (const vrf of vrfs) {
    for (const iface of vrf.interfaces) {
      lines.push(`${padToWidth(ciscoShortInterfaceName(iface.name), 23)}${padToWidth(iface.address ?? 'unassigned', 16)}${padToWidth(vrf.name, 33)}${iface.up ? 'up' : 'down'}`);
    }
  }
  return lines.length === 1 ? '' : lines.join('\n');
}

export interface VpnRow {
  readonly rd: string;
  readonly vrfName: string | null;
  readonly network: string;
  readonly prefixLength: number;
  readonly nextHop: string;
  readonly metric: number;
  readonly localPref: number;
  readonly weight: number;
  readonly asPath: readonly number[];
  readonly origin: 'igp' | 'egp' | 'incomplete';
  readonly internal: boolean;
  readonly best: boolean;
  readonly inLabel: number | null;
  readonly outLabel: number | null;
  readonly routeTargets: readonly string[];
}

const ORIGIN_LETTER: Readonly<Record<VpnRow['origin'], string>> = { igp: 'i', egp: 'e', incomplete: '?' };

function groups(rows: readonly VpnRow[]): Array<{ rd: string; vrfName: string | null; rows: VpnRow[] }> {
  const out = new Map<string, { rd: string; vrfName: string | null; rows: VpnRow[] }>();
  for (const row of rows) {
    const group = out.get(row.rd) ?? { rd: row.rd, vrfName: row.vrfName, rows: [] };
    group.rows.push(row);
    out.set(row.rd, group);
  }
  return [...out.values()];
}

function rdLine(group: { rd: string; vrfName: string | null }): string {
  return `Route Distinguisher: ${group.rd}${group.vrfName === null ? '' : ` (default for vrf ${group.vrfName})`}`;
}

export function formatVpnv4Table(header: { readonly version: number; readonly routerId: string }, rows: readonly VpnRow[]): string {
  const lines = [
    `BGP table version is ${header.version}, local router ID is ${header.routerId}`,
    'Status codes: s suppressed, d damped, h history, * valid, > best, i - internal,',
    '              r RIB-failure, S Stale, m multipath, b backup-path, f RT-Filter,',
    '              x best-external, a additional-path, c RIB-compressed,',
    'Origin codes: i - IGP, e - EGP, ? - incomplete',
    '',
    '     Network          Next Hop            Metric LocPrf Weight Path',
  ];
  for (const group of groups(rows)) {
    lines.push(rdLine(group));
    for (const row of group.rows) {
      const status = `*${row.best ? '>' : ' '}${row.internal ? 'i' : ' '}`;
      const path = row.asPath.length === 0 ? ORIGIN_LETTER[row.origin] : `${row.asPath.join(' ')} ${ORIGIN_LETTER[row.origin]}`;
      lines.push(`${status}${padToWidth(`${row.network}/${row.prefixLength}`, 18)}${padToWidth(row.nextHop, 20)}`
        + `${String(row.metric).padStart(6)} ${row.internal ? String(row.localPref).padStart(6) : '      '} ${String(row.weight).padStart(6)} ${path}`);
    }
  }
  return lines.join('\n');
}

export function formatVpnv4Labels(rows: readonly VpnRow[]): string {
  const lines = ['   Network          Next Hop      In label/Out label'];
  for (const group of groups(rows)) {
    lines.push(`Route Distinguisher: ${group.rd}${group.vrfName === null ? '' : ` (${group.vrfName})`}`);
    for (const row of group.rows) {
      const nextHop = row.inLabel !== null && row.outLabel === null ? '0.0.0.0' : row.nextHop;
      lines.push(`   ${padToWidth(`${row.network}/${row.prefixLength}`, 17)}${padToWidth(nextHop, 16)}`
        + `${row.inLabel === null ? 'nolabel' : row.inLabel}/${row.outLabel === null ? 'nolabel' : row.outLabel}`);
    }
  }
  return lines.join('\n');
}

/**
 * CiscoShowCommands - Extracted show command implementations for Cisco IOS CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by CiscoIOSShell for "show" commands in user and privileged modes.
 */

import type { Router } from '../../Router';
import { dhcpRunningConfigLines } from '../../../dhcp/dhcpRunningConfig';
import { privilegeConfigLines } from '../cli/CliAuthorization';
import { getPrivilegeRules } from '../../router/security/CiscoPrivilegeStore';
import type { Port } from '../../../hardware/Port';
import { IPAddress, SubnetMask, RIP_METRIC_INFINITY } from '../../../core/types';
import { runningConfigACL, runningConfigInterfaceACL } from './CiscoAclCommands';
import { runningConfigObjectGroups } from '@/cli/commands/objectGroup/objectGroupFamily';
import { runningConfigNAT, runningConfigInterfaceNAT } from './CiscoNATCommands';
import { ipSlaRunningConfigLines, trackRunningConfigLines } from './ciscoIpSlaRunningConfig';
import { orderCiscoConfigBlocks, routingProcessConfigLines, policyConfigLines } from './ciscoConfigSerializer';
import { igmpInterfaceRunningConfigLines } from './CiscoIgmpCommands';
import { pimInterfaceRunningConfigLines, pimGlobalRunningConfigLines } from './CiscoPimCommands';
import { globalConfigRunningConfigLines } from '../../router/config/CiscoGlobalConfig';

import { CISCO_HARDWARE_PROFILES, chassisSerial, formatIosUptime, licenseTable, type CiscoChassisProfile } from './CiscoCommonShow';
import {
  renderSecretField, renderPasswordField, renderCiscoUsernameLines,
  type SecretAlgo, type CiscoRenderableAccount,
} from './ciscoPasswordRender';
import { formatInvalidInputAt } from '../CommandTrie';
import { iosInterfaceStatus, iosAddressMethod, iosShortInterfaceName } from '@/network/devices/inspection/InterfaceStatusView';
import { IPv6Address } from '@/network/core/types';
import { renderCounterTable, renderTable, type TableColumn } from '../cli/TextTable';
import { getHttpService } from '@/network/equipment/RouterServiceCapabilities';
import { IPV6_NEIGHBORS_COLUMNS, IPV6_NEIGHBORS_STYLE, type Ipv6NeighborRow } from './ciscoTableLayouts';

export function showVersion(
  router: Router, profile: CiscoChassisProfile = 'router-isr2911',
  registerLine?: string,
): string {
  const ports = router._getPortsInternal();
  const giPorts = [...ports.keys()].filter(n => n.startsWith('Gig') && !n.includes('.'));
  const hw = CISCO_HARDWARE_PROFILES[profile];
  const uptimeMs = router._getUptimeMs?.() ?? 0;
  return [
    `Cisco IOS Software, C2900 Software (C2900-UNIVERSALK9-M), Version 15.7(3)M5`,
    `Copyright (c) 1986-2025 by Cisco Systems, Inc.`,
    '',
    `ROM: System Bootstrap, Version 15.0(1r)M15`,
    '',
    `${router._getHostnameInternal()} uptime is ${formatIosUptime(uptimeMs)}`,
    `System image file is "flash:${hw.flashImage}"`,
    '',
    ...licenseTable(),
    '',
    `Cisco ${hw.pid} (revision 1.0) with ${hw.dramKB}K/${hw.ioMemoryKB}K bytes of memory.`,
    `Processor board ID ${chassisSerial(hw, router.id)}`,
    `${giPorts.length} Gigabit Ethernet interfaces`,
    `DRAM configuration is 64 bits wide with parity enabled.`,
    `${hw.nvramDisplayKB}K bytes of non-volatile configuration memory.`,
    '',
    // Le registre était écrit EN DUR ici, pendant que `show bootvar` sur
    // la même machine rendait la vraie valeur : deux vues, deux réponses.
    registerLine ?? `Configuration register is 0x2102`,
  ].join('\n');
}

/**
 * La queue d'une ligne `ip route` : cible, distance, `permanent`.
 *
 * Elle ne rendait que le prochain saut, ce qui perdait trois choses que
 * l'opérateur avait écrites — et une configuration relue à l'import
 * d'une topologie n'est pas un affichage, c'est ce qui REFAIT la route.
 * La forme par interface revenait en `ip route … 0.0.0.0` (une autre
 * route), une flottante en distance 200 revenait en distance 1 (elle
 * cessait d'être flottante, donc de servir de secours) et `permanent`
 * disparaissait.
 *
 * `ifaceConfigured` est ce qui distingue l'interface NOMMÉE de celle
 * déduite du prochain saut : sans lui, `ip route … 10.1.1.2` se
 * réécrirait en `ip route … GigabitEthernet0/0 10.1.1.2`.
 */
function staticRouteTail(r: {
  nextHop: { toString(): string } | null; iface: string;
  ifaceConfigured?: boolean; preference?: number; permanent?: boolean;
  track?: string;
}): string {
  const nh = r.nextHop ? r.nextHop.toString() : '';
  const parts: string[] = [];
  if (r.ifaceConfigured && r.iface) {
    parts.push(r.iface);
    if (nh && nh !== '0.0.0.0') parts.push(nh);
  } else {
    parts.push(nh);
  }
  if (r.preference !== undefined) parts.push(String(r.preference));
  if (r.track) parts.push('track', r.track);
  if (r.permanent) parts.push('permanent');
  return parts.join(' ');
}



/** La légende d'IOS 15.x, en six lignes. Elle en faisait deux. */
const ROUTE_LEGEND = [
  'Codes: L - local, C - connected, S - static, R - RIP, M - mobile, B - BGP',
  '       D - EIGRP, EX - EIGRP external, O - OSPF, IA - OSPF inter area',
  '       N1 - OSPF NSSA external type 1, N2 - OSPF NSSA external type 2',
  '       E1 - OSPF external type 1, E2 - OSPF external type 2',
  '       i - IS-IS, su - IS-IS summary, L1 - IS-IS level-1, L2 - IS-IS level-2',
  '       ia - IS-IS inter area, * - candidate default, U - per-user static route',
  '       o - ODR, P - periodic downloaded static route, H - NHRP, l - LISP',
  '       a - application route',
  '       + - replicated route, % - next hop override, p - overrides from PfR',
];

interface RenderedRoute {
  code: string;
  networkInt: number;
  prefixLength: number;
  text: string;
}

function routeCode(type: string): string {
  switch (type) {
    case 'connected': return 'C';
    case 'local': return 'L';
    case 'rip': return 'R';
    case 'ospf': return 'O';
    case 'eigrp': return 'D';
    case 'bgp': return 'B';
    case 'default': return 'S*';
    default: return 'S';
  }
}

/** Le réseau classful auquel une route appartient — c'est par lui qu'IOS groupe. */
function classfulParent(networkInt: number): { base: number; prefix: number } {
  const firstOctet = (networkInt >>> 24) & 0xff;
  // `>>> 0` : un ET binaire rend un entier SIGNÉ en JavaScript, donc
  // 192.168.x.x devenait négatif et se triait avant 1.0.0.0.
  if (firstOctet < 128) return { base: (networkInt & 0xff000000) >>> 0, prefix: 8 };
  if (firstOctet < 192) return { base: (networkInt & 0xffff0000) >>> 0, prefix: 16 };
  return { base: (networkInt & 0xffffff00) >>> 0, prefix: 24 };
}

function intToDotted(value: number): string {
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.');
}

function dottedToInt(text: string): number {
  return text.split('.').reduce((total, octet) => (total << 8) + Number(octet), 0) >>> 0;
}

function maskTextToCidr(text: string): number {
  if (/^\d+$/.test(text)) return Number(text);
  return dottedToInt(text).toString(2).split('1').length - 1;
}

/**
 * `show ip route`.
 *
 * Trois faits d'IOS 15.x manquaient, et le premier n'est pas cosmétique :
 * une route CONNECTÉE ne passait pas par `Router.isRouteUsable()` — le
 * prédicat que le plan de données et les vues des deux constructeurs
 * consultent déjà — si bien qu'une interface down laissait sa route
 * affichée, en contradiction frontale avec `show ip interface brief`.
 * Manquaient aussi les routes LOCALES `L …/32`, générées depuis
 * 15.0(1)M pour chaque adresse d'interface, et le regroupement par
 * réseau classful avec son en-tête `is variably subnetted`. Le tri se
 * fait par préfixe, pas par ordre de configuration.
 */
export function showIpRoute(router: Router): string {
  return renderIpRouteTable(router, router.getRoutingTable().filter((r) => router.isRouteUsable(r)));
}

/**
 * Le rendu partagé.
 *
 * Deux fonctions produisaient `show ip route` — celle-ci et
 * `showIpRouteAll` dans `CiscoOspfCommands.ts`, seule branchée sur la
 * commande. Deux rendus de la même table finissent par se contredire ;
 * c'est le défaut « trois commandes, trois vérités » à l'échelle du
 * routage. Il n'en reste qu'un.
 */
export function renderIpRouteTable(
  router: Router,
  table: ReadonlyArray<{
    network: { toString(): string; toUint32?: () => number };
    mask: { toCIDR?: () => number; toString(): string };
    type: string;
    nextHop?: unknown;
    iface?: string;
    ad?: number;
    metric?: number;
  }>,
  codeOverride?: (route: unknown) => string | null,
): string {
  const lines = [...ROUTE_LEGEND, ''];
  const def = table.find(r => r.type === 'default'
    || (r.network.toString() === '0.0.0.0' && r.mask.toCIDR() === 0));
  if (def && def.nextHop) {
    lines.push(`Gateway of last resort is ${def.nextHop} to network 0.0.0.0`, '');
  } else {
    lines.push('Gateway of last resort is not set', '');
  }

  const rendered: RenderedRoute[] = [];
  const defaults: string[] = [];

  for (const r of table) {
    const prefixLength = r.mask.toCIDR
      ? r.mask.toCIDR()
      : maskTextToCidr(r.mask.toString());
    if (r.type === 'default' || (r.network.toString() === '0.0.0.0' && prefixLength === 0)) {
      const code = `${routeCode(r.type === 'default' ? 'static' : r.type)}*`;
      defaults.push(`${code.padEnd(6)}0.0.0.0/0 [${r.ad ?? 1}/${r.metric ?? 0}] via ${r.nextHop}`);
      continue;
    }
    const attachee = !r.nextHop || String(r.nextHop) === '0.0.0.0';
    const via = attachee ? 'is directly connected' : `via ${r.nextHop}`;
    const metricStr = r.type === 'connected' || r.type === 'local'
      ? '' : ` [${r.ad ?? 1}/${r.metric ?? 0}]`;
    const suffix = r.type === 'static' && !attachee ? '' : `, ${r.iface}`;
    const invalide = r.type === 'rip' && (r.metric ?? 0) >= RIP_METRIC_INFINITY;
    rendered.push({
      code: codeOverride?.(r) ?? routeCode(r.type),
      networkInt: r.network.toUint32 ? r.network.toUint32() : dottedToInt(r.network.toString()),
      prefixLength,
      text: invalide
        ? `${r.network}/${prefixLength} is possibly down,\n         routing via ${r.nextHop}, ${r.iface}`
        : `${r.network}/${prefixLength}${metricStr} ${via}${suffix}`,
    });
  }

  // Les routes locales /32 : une par adresse d'interface utilisable.
  for (const [name, port] of router._getPortsInternal()) {
    const ip = port.getIPAddress();
    if (!ip || !router.isRouteInterfaceUsable(name)) continue;
    // Une interface en /32 (une loopback, typiquement) a déjà sa route
    // connectée à la même adresse : IOS n'en affiche pas deux.
    const already = rendered.some((entry) =>
      entry.networkInt === ip.toUint32() && entry.prefixLength === 32);
    if (already) continue;
    rendered.push({
      code: 'L',
      networkInt: ip.toUint32(),
      prefixLength: 32,
      text: `${ip}/32 is directly connected, ${name}`,
    });
  }

  rendered.sort((a, b) => a.networkInt - b.networkInt || a.prefixLength - b.prefixLength);

  const groups = new Map<string, RenderedRoute[]>();
  for (const entry of rendered) {
    const parent = classfulParent(entry.networkInt);
    const key = `${parent.base}/${parent.prefix}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(entry);
    groups.set(key, bucket);
  }

  for (const [key, bucket] of [...groups.entries()]
    .sort((a, b) => Number(a[0].split('/')[0]) - Number(b[0].split('/')[0]))) {
    const [baseText, parentPrefix] = key.split('/');
    const base = intToDotted(Number(baseText));
    const masks = new Set(bucket.map((entry) => entry.prefixLength));
    if (bucket.every((entry) => entry.prefixLength === Number(parentPrefix))) {
      for (const entry of bucket) lines.push(`${entry.code.padEnd(2)}   ${entry.text}`);
      continue;
    }
    lines.push(masks.size > 1
      ? `      ${base}/${parentPrefix} is variably subnetted, ${bucket.length} subnets, ${masks.size} masks`
      : `      ${base}/${parentPrefix} is subnetted, ${bucket.length} subnets`);
    for (const entry of bucket) lines.push(`${entry.code.padEnd(2)}       ${entry.text}`);
  }
  for (const line of defaults) lines.push(line);

  return lines.join('\n');
}

export interface IpIntBriefRow {
  name: string;
  ip: string;
  method: string;
  status: string;
  protocol: string;
}

export function ipIntBriefRowsFromPorts(ports: ReadonlyMap<string, Port>): IpIntBriefRow[] {
  const rows: IpIntBriefRow[] = [];
  for (const [name, port] of ports) {
    const { status, protocol } = iosInterfaceStatus(port, name, ports);
    rows.push({
      name,
      ip: port.getIPAddress()?.toString() || 'unassigned',
      method: iosAddressMethod(port),
      status,
      protocol,
    });
  }
  return rows;
}

export function renderIpIntBrief(rows: readonly IpIntBriefRow[], nameWidth: number): string {
  const lines = [`${'Interface'.padEnd(nameWidth)}${'IP-Address'.padEnd(16)}OK? Method Status                Protocol`];
  for (const r of rows) {
    lines.push(`${r.name.padEnd(nameWidth)}${r.ip.padEnd(16)}YES ${r.method.padEnd(6)} ${r.status.padEnd(22)}${r.protocol}`);
  }
  return lines.join('\n');
}

export function showIpIntBrief(router: Router): string {
  return renderIpIntBrief(ipIntBriefRowsFromPorts(router._getPortsInternal()), 27);
}

/** IOS prints the ARP timeout as hh:mm:ss (default 04:00:00). */
function formatArpTimeout(totalSec: number): string {
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/**
 * `catalyst` adds the reason a switch port is down, in parentheses after
 * the line-protocol state — `(notconnect)` for nothing on the wire,
 * `(disabled)` for a shut port. A Catalyst prints it, a router does not,
 * which is why it is asked for rather than guessed. `(err-disabled)` is
 * the third reason IOS prints and is not covered: the errdisable cause
 * lives on the switch's own bookkeeping, not on the Port this renderer
 * is handed.
 */
export function showInterface(router: { _getPortsInternal: () => Map<string, import('../../../hardware/Port').Port>; getInterfaceDescription?: (n: string) => string | undefined }, ifName: string, catalyst = false): string {
  const ports = router._getPortsInternal();
  const port = ports.get(ifName);
  if (!port) {
    const line = `show interface ${ifName}`;
    const marker = ' '.repeat(line.indexOf(ifName)) + '^';
    return formatInvalidInputAt(marker);
  }

  const view = iosInterfaceStatus(port, ifName, ports);
  const isVirtual = view.virtual;
  const status = view.status;
  const lineProto = view.protocol;
  const ip = port.getIPAddress()?.toString() || 'unassigned';
  const maskObj = port.getSubnetMask();
  const cidr = maskObj ? maskObj.toCIDR() : '';
  const mac = port.getMAC().toCiscoString();

  const isTunnel = ifName.startsWith('Tunnel');
  const isLoopback = ifName.startsWith('Loopback');

  const reason = !catalyst || isVirtual || lineProto === 'up'
    ? ''
    : (view.adminUp ? ' (notconnect)' : ' (disabled)');

  const lines = [
    `${ifName} is ${status}, line protocol is ${lineProto}${reason}`,
  ];

  const descr = router.getInterfaceDescription?.(ifName) || port.getDescriptionText?.();
  if (descr) lines.push(`  Description: ${descr}`);

  if (isTunnel) {
    lines.push(`  Hardware is Tunnel`);
  } else if (isLoopback) {
    lines.push(`  Hardware is Loopback`);
  } else {
    lines.push(`  Hardware is ${ifName.startsWith('Gig') ? 'iGbE' : 'Fast Ethernet'}, address is ${mac} (bia ${mac})`);
  }

  if (ip !== 'unassigned') {
    lines.push(`  Internet address is ${ip}/${cidr}`);
  }

  if (isTunnel) {
    // Show tunnel-specific info
    const extra = (router as any).ospfExtraConfig?.pendingIfConfig;
    if (extra) {
      const tunCfg = extra.get(ifName);
      if (tunCfg?.tunnelSource) lines.push(`  Tunnel source ${tunCfg.tunnelSource}`);
      if (tunCfg?.tunnelDest) lines.push(`  Tunnel destination ${tunCfg.tunnelDest}`);
    }
    // Show tunnel protection info
    const ipsecEngine = (router as any)._getIPSecEngineInternal?.();
    if (ipsecEngine) {
      const tp = ipsecEngine.tunnelProtection?.get(ifName);
      if (tp) {
        lines.push(`  tunnel protection ipsec profile ${tp.profileName}${tp.shared ? ' shared' : ''}`);
      }
    }
    lines.push(`  Tunnel protocol/transport GRE/IP`);
  } else if (isLoopback) {
    // Une loopback n'affichait que trois lignes : l'état, `Hardware is
    // Loopback` et l'adresse. Un vrai IOS en écrit une vingtaine, et
    // deux d'entre elles sont ce qui distingue cette interface des
    // autres — `Encapsulation LOOPBACK` et le MTU de 1514. Bloc relevé
    // sur du texte capturé (jeu `cisco_ios/show_interfaces` de
    // `ntc-templates`).
    const c = port.getCounters();
    lines.push(`  MTU ${port.getMTU()} bytes, BW ${port.getEffectiveBandwidthKbps()} Kbit/sec, DLY ${port.getDelayUs()} usec,`);
    lines.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
    lines.push(`  Encapsulation LOOPBACK, loopback not set`);
    lines.push(`  Keepalive set (${port.getKeepaliveSec()} sec)`);
    lines.push(`  Last input never, output never, output hang never`);
    lines.push(`  Last clearing of "show interface" counters never`);
    lines.push(`  Input queue: 0/75/0/0 (size/max/drops/flushes); Total output drops: 0`);
    lines.push(`  Queueing strategy: fifo`);
    lines.push(`  Output queue: 0/0 (size/max)`);
    lines.push(`  5 minute input rate 0 bits/sec, 0 packets/sec`);
    lines.push(`  5 minute output rate 0 bits/sec, 0 packets/sec`);
    lines.push(`     ${c.framesIn} packets input, ${c.bytesIn} bytes, 0 no buffer`);
    lines.push(`     Received 0 broadcasts (0 IP multicasts)`);
    lines.push(`     0 runts, 0 giants, 0 throttles`);
    lines.push(`     ${c.errorsIn} input errors, 0 CRC, 0 frame, 0 overrun, 0 ignored, 0 abort`);
    lines.push(`     ${c.framesOut} packets output, ${c.bytesOut} bytes, 0 underruns`);
    lines.push(`     ${c.errorsOut} output errors, 0 collisions, 0 interface resets`);
    lines.push(`     0 unknown protocol drops`);
    lines.push(`     0 output buffer failures, 0 output buffers swapped out`);
  } else {
    // Real port state: MTU, the `bandwidth`/`delay` overrides (or the
    // negotiated-speed defaults), duplex and ARP timeout all reflect
    // the live hardware model — not the interface name.
    const speedMbps = port.getNegotiatedSpeed();
    const duplex = port.getNegotiatedDuplex() === 'half'
      ? 'Half-duplex' : 'Full-duplex';
    lines.push(`  MTU ${port.getMTU()} bytes, BW ${port.getEffectiveBandwidthKbps()} Kbit/sec, DLY ${port.getDelayUs()} usec,`);
    lines.push(`     reliability 255/255, txload 1/255, rxload 1/255`);
    lines.push(`  Encapsulation ARPA, loopback not set`);
    lines.push(`  ${duplex}, ${speedMbps}Mbps, media type is RJ45`);
    lines.push(`  output flow-control is unsupported, input flow-control is unsupported`);
    lines.push(`  ARP type: ARPA, ARP Timeout ${formatArpTimeout(port.getArpTimeoutSec())}`);
  }

  if (!isTunnel && !isLoopback) {
    const c = port.getCounters();
    const seen = view.carrierUp ? '00:00:00' : 'never';
    const rxPause = `  Last input ${seen}, output ${seen}, output hang never`;
    lines.push(rxPause);
    lines.push(`  Queueing strategy: fifo`);
    lines.push(`  5 minute input rate 0 bits/sec, 0 packets/sec`);
    lines.push(`  5 minute output rate 0 bits/sec, 0 packets/sec`);
    lines.push(`     ${c.framesIn} packets input, ${c.bytesIn} bytes, 0 no buffer`);
    lines.push(`     Received 0 broadcasts (0 multicasts)`);
    lines.push(`     0 runts, 0 giants, 0 throttles`);
    lines.push(`     ${c.errorsIn} input errors, ${c.crcErrorsIn ?? 0} CRC, 0 frame, 0 overrun, 0 ignored`);
    lines.push(`     ${c.framesOut} packets output, ${c.bytesOut} bytes, 0 underruns`);
    lines.push(`     ${c.errorsOut} output errors, 0 collisions, 0 interface resets`);
    lines.push(`     ${c.dropsIn} input drops, ${c.dropsOut} output drops`);
  }

  return lines.join('\n');
}

// showArp() moved to CiscoArpCommands.ts (shared between router and switch)
export { showArp } from './CiscoArpCommands';

export function showRunningConfig(router: Router): string {
  const ports = router._getPortsInternal();
  const table = router._getRoutingTableInternal();
  const dhcp = router._getDHCPServerInternal();
  const provenance = configProvenanceLines(router);
  const lines = [
    'Building configuration...',
    '',
    'Current configuration:',
    '!',
    ...provenance,
    ...(provenance.length > 0 ? ['!'] : []),
    `hostname ${router._getHostnameInternal()}`,
    '!',
  ];

  for (const kind of ['motd', 'login', 'exec', 'incoming'] as const) {
    const text = router.getBanner?.(kind);
    if (text) {
      lines.push(`banner ${kind} ^C\n${text}\n^C`);
      lines.push('!');
    }
  }

  const serviceEncryption = router.getServiceFlags().get('password-encryption') === true;

  const shell = (router as unknown as {
    shell?: {
      _getConsoleLineConfig?: () => unknown;
      _getAuxLineConfig?: () => unknown;
      _getAliasRunningConfigLines?: () => string[];
    };
  }).shell;

  const aliasLines = shell?._getAliasRunningConfigLines?.() ?? [];
  if (aliasLines.length > 0) {
    for (const ln of aliasLines) lines.push(ln);
    lines.push('!');
  }

  lines.push(...consoleAndAuxLineConfigLines(router, serviceEncryption));

  lines.push(...dhcpRunningConfigLines(dhcp));

  lines.push('!');
  const descs = router._getInterfaceDescriptions();
  for (const [name, port] of ports) {
    lines.push(...interfaceConfigLines(router, name, port, descs, dhcp));
    lines.push('!');
  }

  const groupLines = runningConfigObjectGroups(router._getACLEngineInternal().listObjectGroups());
  if (groupLines.length > 0) lines.push(...groupLines);

  // ACL configuration
  const aclLines = runningConfigACL(router);
  if (aclLines.length > 0) {
    lines.push(...aclLines);
    lines.push('!');
  }

  // NAT configuration
  const natLines = runningConfigNAT(router);
  if (natLines.length > 0) {
    lines.push(...natLines);
    lines.push('!');
  }

  for (const r of table) {
    if (r.type === 'static' && r.nextHop) lines.push(`ip route ${r.network} ${r.mask} ${staticRouteTail(r)}`);
    if (r.type === 'default' && r.nextHop) lines.push(`ip route 0.0.0.0 0.0.0.0 ${staticRouteTail(r)}`);
  }

  const vrfRoutes = (router as unknown as {
    _ciscoVrfRoutes?: Map<string, Array<{
      network: string; mask: string; nextHop: string | null; iface: string | null;
    }>>;
  })._ciscoVrfRoutes;
  for (const [nom, routes] of vrfRoutes ?? []) {
    for (const route of routes) {
      const queue = [route.iface, route.nextHop].filter((x): x is string => !!x).join(' ');
      lines.push(`ip route vrf ${nom} ${route.network} ${route.mask} ${queue}`);
    }
  }

  const vrfs = (router as unknown as { _vrfs?: Map<string, { name: string; rd?: string }> })._vrfs;
  if (vrfs && vrfs.size > 0) {
    lines.push('!');
    for (const v of vrfs.values()) {
      lines.push(`ip vrf ${v.name}`);
      if (v.rd) lines.push(` rd ${v.rd}`);
    }
  }

  const vlans = (router as unknown as { _vlans?: Map<number, { id: number; name?: string }> })._vlans;
  if (vlans && vlans.size > 0) {
    lines.push('!');
    for (const v of vlans.values()) {
      lines.push(`vlan ${v.id}`);
      if (v.name) lines.push(` name ${v.name}`);
    }
  }

  // Les vues AVANT les comptes : `username X view NOC` refuse une vue
  // inconnue, donc une configuration qui nommerait la vue apres le
  // compte ne pourrait pas etre rejouee — et c'est ce que l'import
  // d'une topologie fait de cette configuration.
  const viewLines = (router as unknown as {
    [s: symbol]: { parserViewLines?: () => string[] } | undefined;
  })[Symbol.for('CiscoSecurityConfig')]?.parserViewLines?.() ?? [];
  if (viewLines.length > 0) {
    lines.push('!');
    lines.push(...viewLines);
  }

  // Local AAA users (`username NAME privilege N secret …`).
  const listUsers = (router as unknown as {
    _listLocalUsers?: () => ReadonlyArray<CiscoRenderableAccount>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router);
    if (users.length > 0) {
      lines.push('!');
      for (const u of users) {
        lines.push(...renderCiscoUsernameLines(u, serviceEncryption));
      }
    }
  }

  // VTY line configuration (exec-timeout, access-class, transport input, …)
  const vtyStore = (router as unknown as { _getVtyLineConfig?: () => { renderAllCisco: (e?: boolean) => string[] } })._getVtyLineConfig?.();
  if (vtyStore) {
    const vtyLines = vtyStore.renderAllCisco(serviceEncryption);
    if (vtyLines.length > 0) {
      lines.push(...vtyLines);
    }
  }

  if (!router.isIpRoutingEnabled()) {
    lines.push('no ip routing');
    lines.push('!');
  }

  if (router.isIPv6RoutingEnabled()) {
    lines.push('ipv6 unicast-routing');
    lines.push('!');
  }

  const enableSecret = router.getEnableSecret();
  if (enableSecret) {
    lines.push(`enable secret ${renderSecretField(enableSecret.value, enableSecret.algo, 'enable')}`);
  }
  const enablePassword = router.getEnablePassword();
  if (enablePassword) {
    // Real IOS: unlike `username … password 0 …`, a plaintext `enable
    // password` is never shown with an explicit `0` type digit.
    lines.push(`enable password ${renderPasswordField(enablePassword.value, enablePassword.algo, serviceEncryption, false, 'enable')}`);
  }
  lines.push(...enableLevelSecretConfigLines(router, serviceEncryption));
  for (const [name, on] of router.getServiceFlags()) {
    lines.push(`${on ? '' : 'no '}service ${name}`);
  }

  const dnsCfg = (router as unknown as {
    _getDnsConfig?: () => import('../../router/dns/CiscoDnsConfig').CiscoDnsConfig;
  })._getDnsConfig?.();
  if (dnsCfg) lines.push(...dnsCfg.runningConfigLines());
  lines.push(...hostsTableLines(router));

  const mgmtForSsh = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (mgmtForSsh) {
    // Les lignes `ip ssh version|time-out|authentication-retries` sont
    // rendues par `CiscoSecurityConfig.runningConfigLines()`, qui lit le
    // magasin que la CLI ECRIT vraiment. Elles etaient rendues ICI AUSSI,
    // depuis un SECOND magasin que le gestionnaire porte et que le
    // handler `ip ssh` du routeur n'ecrit jamais : les deux avaient des
    // defauts contradictoires (version 1 contre 2, delai 120 contre 60)
    // et pouvaient emettre la meme directive deux fois dans un meme
    // fichier. Ce qui reste ici est ce que ce magasin est SEUL a porter.
    const ssh = mgmtForSsh.getSsh();
    if (ssh.enabled) {
      const port = (ssh as unknown as { port?: number }).port ?? 22;
      if (port !== 22) lines.push(`ip ssh port ${port}`);
    }
  }

  // Le serveur web. Ces lignes etaient ABSENTES dans les deux sens : les
  // deux drapeaux vivaient dans `CiscoConfigState`, une table dont le
  // rendu n'a aucun appelant, donc `ip http server` disparaissait a
  // l'enregistrement et le serveur ne redemarrait pas a l'import.
  const httpSvc = getHttpService(router);
  if (httpSvc) {
    const httpLines = httpSvc.runningConfigLines();
    if (httpLines.length > 0) lines.push(...httpLines);
  }

  const reglesPriv = privilegeConfigLines(
    getPrivilegeRules(router),
  );
  if (reglesPriv.length > 0) lines.push(...reglesPriv);

  const unhandled = router.getUnhandledConfigLines();
  if (unhandled.length > 0) {
    lines.push('!');
    lines.push(...unhandled);
  }

  const mgmt = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (mgmt) {
    const clock = mgmt.getClock();
    if (clock.timezone !== 'UTC') {
      const sign = clock.offsetMin >= 0 ? '' : '-';
      const abs = Math.abs(clock.offsetMin);
      lines.push(`clock timezone ${clock.timezone} ${sign}${Math.floor(abs / 60)} ${abs % 60}`);
    }
    if (clock.summerTimezone) {
      lines.push(`clock summer-time ${clock.summerTimezone} recurring ${clock.daylightStart} ${clock.daylightEnd}`);
    }
  }

  const loggingCfg = (router as unknown as { _loggingConfig?: { asRunningConfigLines: () => string[] } })._loggingConfig;
  if (loggingCfg) {
    const ll = loggingCfg.asRunningConfigLines();
    if (ll.length > 0) { lines.push('!'); lines.push(...ll); }
  }

  const shellWithKeyChains = (router as unknown as { getShell?: () => { getKeyChains?: () => { asRunningConfigLines(): string[] } } }).getShell?.();
  const kcRepo = shellWithKeyChains?.getKeyChains?.();
  if (kcRepo) {
    const kl = kcRepo.asRunningConfigLines();
    if (kl.length > 0) { lines.push('!'); lines.push(...kl); }
  }

  const ntpAgent = (router as unknown as { getNtpAgent?: () => { asRunningConfigLines?: () => string[] } }).getNtpAgent?.();
  if (ntpAgent?.asRunningConfigLines) {
    const nl = ntpAgent.asRunningConfigLines();
    if (nl.length > 0) { lines.push('!'); lines.push(...nl); }
  }

  const cdp = (router as unknown as { getCdpAgent?: () => { asRunningConfigLines?: () => string[] } }).getCdpAgent?.();
  if (cdp?.asRunningConfigLines) {
    const cl = cdp.asRunningConfigLines();
    if (cl.length > 0) { lines.push('!'); lines.push(...cl); }
  }

  const lldp = (router as unknown as { getLldpAgent?: () => { asRunningConfigLines?: () => string[] } }).getLldpAgent?.();
  if (lldp?.asRunningConfigLines) {
    const lll = lldp.asRunningConfigLines();
    if (lll.length > 0) { lines.push('!'); lines.push(...lll); }
  }

  const snmp = (router as unknown as { getSnmpService?: () => import('../../router/management/SnmpService').SnmpService }).getSnmpService?.();
  if (snmp) {
    const sl = snmp.asRunningConfigLines();
    if (sl.length > 0) { lines.push('!'); lines.push(...sl); }
  }

  const netflow = (router as unknown as { getNetflowService?: () => import('../../router/netflow/NetflowService').NetflowService }).getNetflowService?.();
  if (netflow) {
    const nl = netflow.asRunningConfigLines();
    if (nl.length > 0) { lines.push('!'); lines.push(...nl); }
  }

  const archive = (router as unknown as { getArchiveService?: () => import('../../router/archive/ArchiveService').ArchiveService }).getArchiveService?.();
  if (archive) {
    const al = archive.asRunningConfigLines();
    if (al.length > 0) { lines.push('!'); lines.push(...al); }
  }

  const eem = (router as unknown as { getEemService?: () => import('../../router/eem/EemService').EemService }).getEemService?.();
  if (eem) {
    const el = eem.asRunningConfigLines();
    if (el.length > 0) { lines.push('!'); lines.push(...el); }
  }

  const securityLines = (router as unknown as {
    [s: symbol]: { asRunningConfigLines?: () => string[] } | undefined;
  })[Symbol.for('CiscoSecurityConfig')]?.asRunningConfigLines?.() ?? [];
  if (securityLines.length > 0) {
    lines.push('!');
    lines.push(...securityLines);
    lines.push('!');
  }

  const globalLines = globalConfigRunningConfigLines(router);
  if (globalLines.length > 0) { lines.push('!'); lines.push(...globalLines); }

  const pimLines = pimGlobalRunningConfigLines(router);
  if (pimLines.length > 0) { lines.push('!'); lines.push(...pimLines); }

  const slaLines = ipSlaRunningConfigLines(router);
  if (slaLines.length > 0) { lines.push('!'); lines.push(...slaLines); }
  const trackLines = trackRunningConfigLines(router);
  if (trackLines.length > 0) { lines.push('!'); lines.push(...trackLines); }

  const ipsec = router._getIPSecEngineInternal?.();
  if (ipsec) {
    const cryptoLines = ipsec.asRunningConfigLines();
    if (cryptoLines.length > 0) {
      lines.push(...cryptoLines);
      lines.push('!');
    }
  }

  const configShell = (router as unknown as {
    shell?: {
      getRoutingConfig?: () => import('../../inspection/config/RoutingConfigRepository').RoutingConfigRepository;
      getPolicyRepo?: () => import('../../inspection/config/PolicyRepository').PolicyRepository;
    };
  }).shell;
  const routingRepo = configShell?.getRoutingConfig?.();
  if (routingRepo) {
    const ospfCfg = router._getOSPFEngineInternal?.()?.getConfig();
    const routingLines = routingProcessConfigLines(routingRepo, ospfCfg ? {
      processId: ospfCfg.processId,
      routerId: ospfCfg.routerId,
      networks: ospfCfg.networks,
      passiveInterfaces: [...ospfCfg.passiveInterfaces],
    } : null);
    if (routingLines.length > 0) { lines.push('!'); lines.push(...routingLines); }
  }
  const policyRepo = configShell?.getPolicyRepo?.();
  if (policyRepo) {
    const policyLines = policyConfigLines(policyRepo);
    if (policyLines.length > 0) { lines.push('!'); lines.push(...policyLines); }
  }

  // IOS closes the configuration with a separator before `end`, and its
  // header reports the stored size in bytes.
  //
  // La provenance fait partie de l'EN-TETE et ne traverse donc pas le
  // tri des blocs : `! Last configuration change ...` commence par `!`
  // sans etre le separateur `!`, si bien que le decoupeur en faisait un
  // bloc ordinaire, que rien ne classait, et qui sortait au milieu des
  // commandes globales. Aucun IOS n'ecrit sa provenance apres ses
  // interfaces, et cette configuration est rejouee a l'import.
  const tailleEnTete = 4 + provenance.length + (provenance.length > 0 ? 1 : 0);
  const header = lines.slice(0, tailleEnTete);
  const ordered = orderCiscoConfigBlocks(lines.slice(tailleEnTete));
  const assembled = [...header, ...ordered, 'end'];
  const body = assembled.slice(4).join('\n');
  assembled[2] = `Current configuration : ${new TextEncoder().encode(body).length + 1} bytes`;
  return assembled.join('\n');
}

/**
 * Les deux lignes d'en-tête d'IOS : quand la configuration a changé, et
 * quand la NVRAM a été écrite.
 *
 *     ! Last configuration change at 14:32:15 UTC Tue Aug 9 2026 by admin
 *     ! NVRAM config last updated at 09:15:00 UTC Mon Aug 8 2026 by admin
 *
 * Ce ne sont pas des ornements : l'ÉCART entre elles est le signal
 * d'audit du chapitre — deux dates différentes veulent dire qu'on a
 * modifié sans sauvegarder. Elles n'existaient pas, donc la question ne
 * pouvait pas être posée à la machine.
 *
 * Une ligne absente est absente : IOS n'écrit la seconde que si la
 * NVRAM a été écrite au moins une fois, et rendre une date inventée
 * pour une sauvegarde qui n'a jamais eu lieu serait exactement le
 * contraire de ce que l'auditeur cherche.
 */
export function configProvenanceLines(router: Router): string[] {
  const dev = router as unknown as {
    _getConfigProvenance?: () => {
      changedAtMs: number | null; changedBy: string | null;
      nvramAtMs: number | null; nvramBy: string | null;
    };
  };
  const p = dev._getConfigProvenance?.();
  if (!p) return [];
  const lignes: string[] = [];
  if (p.changedAtMs !== null) {
    lignes.push(`! Last configuration change at ${horodatageIos(p.changedAtMs)}`
      + `${p.changedBy ? ` by ${p.changedBy}` : ''}`);
  }
  if (p.nvramAtMs !== null) {
    lignes.push(`! NVRAM config last updated at ${horodatageIos(p.nvramAtMs)}`
      + `${p.nvramBy ? ` by ${p.nvramBy}` : ''}`);
  }
  return lignes;
}

const JOURS_IOS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MOIS_IOS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** `14:32:15 UTC Tue Aug 9 2026` — la date telle qu'IOS l'écrit ici. */
function horodatageIos(ms: number): string {
  const d = new Date(ms);
  const deux = (n: number) => String(n).padStart(2, '0');
  return `${deux(d.getHours())}:${deux(d.getMinutes())}:${deux(d.getSeconds())} UTC `
    + `${JOURS_IOS[d.getDay()]} ${MOIS_IOS[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
}

/**
 * The lines of ONE interface block, in IOS's own order.
 *
 * There used to be two hand-written renderers of this block —
 * `show running-config` and `show running-config interface <name>` —
 * and the second knew about a subset of the first. Measured on one
 * machine at one instant: the full configuration listed
 * `ipv6 address 2001:db8::1/64` and `ipv6 traffic-filter BLOCK in`
 * where the per-interface view showed neither. Two possible answers
 * to one question is the defect; there is one builder now.
 */
const OSPF_IF_DEFAULTS: Record<string, unknown> = {
  priority: 1, helloInterval: 10, deadInterval: 40, networkType: 'broadcast',
  retransmitInterval: 5, transmitDelay: 1, authType: 0,
};

function ospfInterfaceRunningConfigLines(pending: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const ecart = (cle: string) =>
    pending[cle] !== undefined && pending[cle] !== OSPF_IF_DEFAULTS[cle];

  if (pending.cost !== undefined) lines.push(` ip ospf cost ${pending.cost}`);
  if (ecart('priority')) lines.push(` ip ospf priority ${pending.priority}`);
  if (ecart('helloInterval')) lines.push(` ip ospf hello-interval ${pending.helloInterval}`);
  if (ecart('deadInterval')) lines.push(` ip ospf dead-interval ${pending.deadInterval}`);
  if (ecart('networkType')) lines.push(` ip ospf network ${pending.networkType}`);
  if (ecart('retransmitInterval')) lines.push(` ip ospf retransmit-interval ${pending.retransmitInterval}`);
  if (ecart('transmitDelay')) lines.push(` ip ospf transmit-delay ${pending.transmitDelay}`);
  if (pending.authType === 1) lines.push(' ip ospf authentication');
  if (pending.authType === 2) lines.push(' ip ospf authentication message-digest');
  if (pending.authKey) lines.push(` ip ospf authentication-key ${pending.authKey}`);
  if (pending.mtuIgnore) lines.push(' ip ospf mtu-ignore');
  if (pending.demandCircuit) lines.push(' ip ospf demand-circuit');
  if (pending.bfd) lines.push(' ip ospf bfd');
  if (pending.floodReduction) lines.push(' ip ospf flood-reduction');
  if (pending.databaseFilterAllOut) lines.push(' ip ospf database-filter all out');
  return lines;
}

function legacyInterfaceLines(port: Port): string[] {
  const lines: string[] = [];
  const mss = port.getTcpAdjustMss();
  const rate = port.getDhcpSnoopingRateLimit();
  const pool = port.getIpv6DhcpPool();
  const wfq = port.getFairQueueConfig();
  const pbr = port.getPolicyRouteMap();

  if (pbr) lines.push(` ip policy route-map ${pbr}`);
  if (port.isDirectedBroadcastEnabled()) lines.push(' ip directed-broadcast');
  if (mss !== null) lines.push(` ip tcp adjust-mss ${mss}`);
  if (port.isIpAccountingEnabled()) lines.push(' ip accounting');
  if (port.isDhcpRelayInfoTrusted()) lines.push(' ip dhcp relay information trusted');
  if (port.isDhcpSnoopingTrusted()) lines.push(' ip dhcp snooping trust');
  if (rate !== null) lines.push(` ip dhcp snooping limit rate ${rate}`);
  if (port.isRipV2Broadcast()) lines.push(' ip rip v2-broadcast');
  if (port.isNbarProtocolDiscoveryEnabled()) lines.push(' ip nbar protocol-discovery');
  if (pool) lines.push(` ipv6 dhcp server ${pool}`);
  for (const d of port.getIpv6DhcpRelayDestinations()) {
    lines.push(` ipv6 dhcp relay destination ${d}`);
  }
  if (wfq) lines.push(` ${wfq.trim()}`);
  if (port.isWredEnabled()) lines.push(' random-detect');
  const maxRes = port.getMaxReservedBandwidth();
  if (maxRes !== null) lines.push(` max-reserved-bandwidth ${maxRes}`);
  const prio = port.getPriorityGroup();
  if (prio !== null) lines.push(` priority-group ${prio}`);
  const cql = port.getCustomQueueList();
  if (cql !== null) lines.push(` custom-queue-list ${cql}`);
  const txRing = port.getTxRingLimit();
  if (txRing !== null) lines.push(` tx-ring-limit ${txRing}`);

  return lines;
}

function interfaceConfigLines(
  router: Router, name: string, port: Port,
  descs: Map<string, string>, dhcp: ReturnType<Router['_getDHCPServerInternal']>,
): string[] {
  const lines: string[] = [];
  lines.push(`interface ${name}`);
  const desc = descs.get(name);
  if (desc) lines.push(` description ${desc}`);
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const enc = (port as unknown as { encapsulation?: { type: string; vlan?: number; native?: boolean } }).encapsulation;
  if (enc && enc.type) {
    lines.push(` encapsulation ${enc.type}${enc.vlan != null ? ' ' + enc.vlan : ''}${enc.native ? ' native' : ''}`);
  }
  // `no ip address` est RENDU : sans lui, la configuration ne permet
  // pas de distinguer une interface sans adresse d'une interface dont
  // l'adresse aurait été omise — et c'est ce texte que l'import de
  // topologie rejoue.
  if (port.isDhcpClient()) lines.push(' ip address dhcp');
  else if (ip && mask) lines.push(` ip address ${ip} ${mask}`);
  else if (!/^(Tunnel|Loopback|Vlan|BVI|Port-channel|Null)/i.test(name)) {
    lines.push(' no ip address');
  }
  for (const sec of port.getSecondaryIPs()) lines.push(` ip address ${sec.ip} ${sec.mask} secondary`);
  lines.push(...runningConfigInterfaceIPv6(port));
  // IOS ne rend que l'ecart au defaut du processus : `no ip
  // split-horizon` se voit, l'etat par defaut non.
  if (router.isRIPEnabled() && !router.ripSplitHorizonOn(name)) {
    lines.push(' no ip split-horizon');
  }
  if (port.getMTU() !== 1500) lines.push(` mtu ${port.getMTU()}`);
  if (port.getBandwidthKbps() > 0) lines.push(` bandwidth ${port.getBandwidthKbps()}`);
  if (port.hasExplicitDelayUs()) lines.push(` delay ${Math.round(port.getDelayUs() / 10)}`);
  if (!port.getIsUp()) lines.push(` shutdown`);
  // Le durcissement d'une interface se REJOUE : sans cette ligne, un
  // `ntp disable` posé sur un lien exterieur disparaissait a l'import
  // de la topologie et l'interface revenait servante.
  if (ntpAgentOf(router)?.isInterfaceDisabled(name)) lines.push(` ntp disable`);
  if (!port.isNegotiationAuto?.()) {
    const sp = port.getSpeed?.();
    if (sp) lines.push(` speed ${sp}`);
    const dx = port.getDuplex?.();
    if (dx) lines.push(` duplex ${dx}`);
  }
  const helpers = dhcp.getHelperAddresses(name);
  for (const h of helpers) {
    lines.push(` ip helper-address ${h}`);
  }
  lines.push(...runningConfigInterfaceACL(router, name));
  lines.push(...runningConfigInterfaceNAT(router, name));
  for (const l of port.getEigrpSummaries()) lines.push(` ${l}`);
  for (const l of port.getEigrpExtras()) lines.push(` ${l}`);
  for (const l of port.getRipSummaries()) lines.push(` ${l}`);
  for (const l of (port as unknown as { ripAuth?: string[] }).ripAuth ?? []) lines.push(` ${l}`);
  const sec = (router as unknown as {
    [s: symbol]: { asInterfaceRunningConfigLines?: (iface: string) => string[] } | undefined;
  })[Symbol.for('CiscoSecurityConfig')];
  if (sec?.asInterfaceRunningConfigLines) lines.push(...sec.asInterfaceRunningConfigLines(name));
  const nhrp = (router as unknown as { getNhrpService?: () => { asRunningConfigInterface: (n: string) => string[] } }).getNhrpService?.();
  if (nhrp) lines.push(...nhrp.asRunningConfigInterface(name));
  const nf = (router as unknown as { getNetflowService?: () => { asInterfaceRunningConfigLines: (n: string) => string[] } }).getNetflowService?.();
  if (nf) lines.push(...nf.asInterfaceRunningConfigLines(name));
  lines.push(...legacyInterfaceLines(port));
  lines.push(...igmpInterfaceRunningConfigLines(router, name));
  lines.push(...pimInterfaceRunningConfigLines(router, name));
  // `rate-limit` (CAR historique) était STOCKÉ sur le port et rendu
  // nulle part : la commande était acceptée, absente de la
  // running-config, et sans vue pour la contredire. Le stockage
  // existait, il lui manquait ses deux portes.
  for (const r of (router.getCarPolicer(name)?.list() ?? [])) lines.push(` ${r.raw}`);
  const ospfExtra = (router as unknown as { _getOSPFExtraConfig?: () => { pendingIfConfig: Map<string, Record<string, unknown>> } })._getOSPFExtraConfig?.();
  const pending = ospfExtra?.pendingIfConfig.get(name);
  if (pending) {
    lines.push(...ospfInterfaceRunningConfigLines(pending));
    if (pending.tunnelMode) lines.push(` tunnel mode ${pending.tunnelMode}`);
    if (pending.tunnelSource) lines.push(` tunnel source ${pending.tunnelSource}`);
    if (pending.tunnelDest) lines.push(` tunnel destination ${pending.tunnelDest}`);
    if (pending.tunnelKey) lines.push(` tunnel key ${pending.tunnelKey}`);
    if (pending.tunnelVrf) lines.push(` tunnel vrf ${pending.tunnelVrf}`);
    const pmtud = pending.tunnelPathMtuDiscovery as { enabled: boolean; ageTimer?: number; minMtu?: number } | undefined;
    if (pmtud?.enabled) {
      let s = ' tunnel path-mtu-discovery';
      if (pmtud.ageTimer !== undefined) s += ` age-timer ${pmtud.ageTimer}`;
      if (pmtud.minMtu !== undefined) s += ` min-mtu ${pmtud.minMtu}`;
      lines.push(s);
    }
    if (pending.bfdInterval !== undefined) {
      lines.push(` bfd interval ${pending.bfdInterval}${pending.bfdMinRx !== undefined ? ' min_rx ' + pending.bfdMinRx : ''}${pending.bfdMultiplier !== undefined ? ' multiplier ' + pending.bfdMultiplier : ''}`);
    }
    if (pending.bfdTemplate) lines.push(` bfd template ${pending.bfdTemplate}`);
    if (pending.bfdEcho) lines.push(' bfd echo');
    const fr = pending.frameRelay as Record<string, unknown> | undefined;
    if (fr) {
      if (fr.dlci !== undefined) lines.push(` frame-relay interface-dlci ${fr.dlci}`);
      if (fr.lmiType) lines.push(` frame-relay lmi-type ${fr.lmiType}`);
      if (fr.inverseArp) lines.push(' frame-relay inverse-arp');
      for (const m of (fr.maps as Array<{ ip: string; dlci: number }>) ?? []) {
        lines.push(` frame-relay map ip ${m.ip} ${m.dlci}`);
      }
    }
  }
  return lines;
}

export function showRunningConfigInterface(router: Router, ifName: string): string {
  const port = router.getPort(ifName);
  if (!port) return `% Invalid interface "${ifName}"`;

  const lines = [
    'Building configuration...',
    '',
    // Remplacé une fois le corps connu : l'en-tête annonce une TAILLE,
    // pas le nom de ce qu'on affiche.
    '',
    '!',
    ...interfaceConfigLines(
      router, ifName, port,
      router._getInterfaceDescriptions(), router._getDHCPServerInternal()),
  ];
  lines.push('end');
  const corps = lines.slice(3).join('\n') + '\n';
  lines[2] = `Current configuration : ${new TextEncoder().encode(corps).length} bytes`;
  return lines.join('\n');
}

export function showCounters(router: Router): string {
  const c = router.getCounters();
  return [
    'IP statistics:',
    `  Rcvd:  ${c.ifInOctets} total octets`,
    `  Sent:  ${c.ifOutOctets} total octets`,
    `  Frags: ${c.ipForwDatagrams} forwarded`,
    `  Drop:  ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} address errors`,
    '',
    'ICMP statistics:',
    `  Sent: ${c.icmpOutMsgs} total`,
    `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
    `    Time exceeded: ${c.icmpOutTimeExcds}`,
    `    Echo replies: ${c.icmpOutEchoReps}`,
  ].join('\n');
}

export function showIpProtocols(router: Router): string {
  const sections: string[] = [];

  const ospf = router.isOSPFEnabled?.() ? router._getOSPFEngineInternal?.() : null;
  if (ospf) {
    const cfg = ospf.getConfig();
    const aires = [...cfg.areas.values()];
    const normales = aires.filter(a => a.type === 'normal').length;
    const stub = aires.filter(a => a.type === 'stub' || a.type === 'totally-stubby').length;
    const nssa = aires.filter(a => a.type === 'nssa').length;
    const block: string[] = [
      `Routing Protocol is "ospf ${cfg.processId}"`,
      `  Outgoing update filter list for all interfaces is not set`,
      `  Incoming update filter list for all interfaces is not set`,
      `  Router ID ${cfg.routerId}`,
      `  Number of areas in this router is ${aires.length}.`
        + ` ${normales} normal ${stub} stub ${nssa} nssa`,
      `  Reference bandwidth unit is ${cfg.autoCostReferenceBandwidth} mbps`,
      '  Maximum path: 4',
      `  Routing for Networks:`,
    ];
    for (const n of cfg.networks) block.push(`    ${n.network} ${n.wildcard} area ${n.areaId}`);
    // `passive-interface` était accepté, honoré par le moteur, et
    // rapporté par personne : ni ici, ni dans la configuration. C'est
    // pourtant la vue où un opérateur va vérifier qu'une interface
    // n'émet plus, et la seule qui les liste toutes ensemble.
    const passives = [...cfg.passiveInterfaces].sort();
    if (passives.length > 0) {
      block.push('  Passive Interface(s):');
      for (const iface of passives) block.push(`    ${iface}`);
    }
    block.push('  Routing Information Sources:', '    Gateway         Distance      Last Update');
    for (const iface of ospf.getInterfaces().values()) {
      for (const nbr of iface.neighbors.values()) {
        block.push(`    ${nbr.routerId.padEnd(16)}110           00:00:00`);
      }
    }
    block.push('  Distance: (default is 110)');
    sections.push(block.join('\n'));
  }

  if (router.isRIPEnabled()) {
    sections.push(ripProtocolsBlock(router));
  }

  const ipv6Engine = (router as unknown as { isBGPEnabled?: () => boolean }).isBGPEnabled?.();
  if (ipv6Engine) {
    sections.push('Routing Protocol is "bgp"');
  }

  if (sections.length === 0) return 'No routing protocol is configured.';
  return sections.join('\n\n');
}

function ripProtocolsBlock(router: Router): string {
  const cfg = router.getRIPConfig();
  const repo = (router as unknown as {
    shell?: { getRoutingConfig?: () => import('../../inspection/config/RoutingConfigRepository').RoutingConfigRepository };
  }).shell?.getRoutingConfig?.();
  const rip = repo?.rip;

  const secondes = (ms: number) => Math.round(ms / 1000);
  const minuteur = (rip?.timersBasic ?? '').match(/\d+/g)?.map(Number) ?? [];
  const update = minuteur[0] ?? secondes(cfg.updateInterval);
  const invalid = minuteur[1] ?? secondes(cfg.routeTimeout);
  const holddown = minuteur[2] ?? secondes(cfg.routeTimeout);
  const flush = minuteur[3] ?? (secondes(cfg.routeTimeout) + secondes(cfg.gcTimeout));

  const version = rip?.version ?? null;
  const envoi = version === null ? '1' : String(version);
  const reception = version === null ? '2 1' : String(version);
  const controleVersion = version === null
    ? 'send version 1, receive any version'
    : `send version ${version}, receive version ${version}`;

  const block: string[] = [
    'Routing Protocol is "rip"',
    '  Outgoing update filter list for all interfaces is not set',
    '  Incoming update filter list for all interfaces is not set',
    `  Sending updates every ${update} seconds, next due in ${Math.max(1, Math.round(update / 2))} seconds`,
    `  Invalid after ${invalid} seconds, hold down ${holddown}, flushed after ${flush}`,
  ];

  const sources = (rip?.redistribute ?? []).map((r) => r.protocol);
  block.push(`  Redistributing: ${['rip', ...sources].join(', ')}`);

  block.push(`  Default version control: ${controleVersion}`);
  block.push('    Interface             Send  Recv  Triggered RIP  Key-chain');
  const passivesTable = new Set([...(rip?.passive ?? []), ...cfg.passiveInterfaces]);
  for (const [nom, port] of router._getPortsInternal()) {
    const ip = port.getIPAddress();
    if (!ip) continue;
    if (!ripCoversAddress(cfg.networks, ip)) continue;
    if (passivesTable.has(nom)) continue;
    const envoiIf = router.ripSendVersionOn?.(nom) ?? envoi;
    const receptionIf = router.ripReceiveVersionOn?.(nom) ?? reception;
    const cle = router.ripAuthKeyChainOn?.(nom) ?? '';
    block.push(`    ${nom.padEnd(22)}${envoiIf.padEnd(6)}${receptionIf.padEnd(6)}${''.padEnd(15)}${cle}`);
  }

  block.push(`  Automatic network summarization is ${rip?.autoSummary === false ? 'not ' : ''}in effect`);
  block.push(`  Maximum path: ${rip?.maximumPaths ?? 4}`);

  block.push('  Routing for Networks:');
  const reseaux = (rip?.networks ?? []).length > 0
    ? rip!.networks
    : cfg.networks.map((n) => n.network.toString());
  for (const n of reseaux) block.push(`    ${n}`);

  const passives = [...new Set([...(rip?.passive ?? []), ...cfg.passiveInterfaces])].sort();
  if (passives.length > 0) {
    block.push('  Passive Interface(s):');
    for (const iface of passives) block.push(`    ${iface}`);
  }
  if (rip?.passiveDefault) {
    const actives = [...router._getPortsInternal().keys()].filter((n) => !passives.includes(n));
    if (actives.length > 0) {
      block.push('  Active Interface(s):');
      for (const iface of actives) block.push(`    ${iface}`);
    }
  }

  block.push('  Routing Information Sources:');
  block.push('    Gateway         Distance      Last Update');
  const distance = rip?.distance ?? 120;
  for (const [source, age] of router.getRIPUpdateSources()) {
    block.push(`    ${source.padEnd(16)}${String(distance).padEnd(14)}${formatRipAge(age)}`);
  }
  block.push(`  Distance: (default is ${distance})`);
  return block.join('\n');
}

/** `show interfaces` (all) — real per-port detail for every interface. */
export function showInterfaceAccounting(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const c = port.getCounters();
  // L'en-tête et la ligne étaient deux chaînes indépendantes, comptées
  // chacune de son côté : toutes les colonnes de données finissaient un
  // caractère avant leur intitulé (22/34/46/58/70 contre 24/35/47/59/71).
  return [
    `${ifName}`,
    ...renderCounterTable('Protocol', ['Pkts In', 'Chars In', 'Pkts Out', 'Chars Out'], [
      { label: 'IP', cells: [String(c.framesIn), String(c.bytesIn), String(c.framesOut), String(c.bytesOut)] },
    ]),
  ].join('\n');
}

export function showInterfaceStats(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const c = port.getCounters();
  // `Distributed cache` et `Total` finissaient un caractère avant les
  // deux autres lignes, chacune ayant son propre décompte d'espaces.
  const compteurs = [String(c.framesIn), String(c.bytesIn), String(c.framesOut), String(c.bytesOut)];
  const zeros = ['0', '0', '0', '0'];
  return [
    `${ifName}`,
    ...renderCounterTable('Switching path', ['Pkts In', 'Chars In', 'Pkts Out', 'Chars Out'], [
      { label: 'Processor', cells: compteurs },
      { label: 'Route cache', cells: zeros },
      { label: 'Distributed cache', cells: zeros },
      { label: 'Total', cells: compteurs },
    ]),
  ].join('\n');
}

/**
 * `show interfaces <if> rate-limit` — les politiques CAR posées sur
 * l'interface.
 *
 * Choix assumé, et il suit la maison plutôt qu'une préférence : la QoS
 * de ce simulateur est fidèle au niveau CONFIGURATION et ne police
 * aucun paquet. Mesuré avant de trancher — la MQC moderne
 * (`class-map`/`policy-map`/`police`) est stockée, rendue en
 * running-config ET affichée par `show policy-map`, sans qu'aucun octet
 * ne soit jamais jeté. Refuser `rate-limit`, qui est le CAR historique
 * de la même famille, aurait rendu la plateforme incohérente avec
 * elle-même : `police` accepté, `rate-limit` refusé, pour la même
 * absence de moteur.
 *
 * Les compteurs sont donc à zéro et c'est la vérité de cet équipement,
 * pas un remplissage : rien ne mesure, donc rien n'est compté.
 */
export function showInterfaceRateLimit(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const regles = router.getCarPolicer(ifName)?.list() ?? [];
  if (regles.length === 0) return `${ifName}`;
  const lines = [`${ifName}`];
  const maintenant = Date.now();
  for (const r of regles) {
    lines.push(`  ${r.direction === 'input' ? 'Input' : 'Output'}`);
    lines.push(`    matches: all traffic`);
    lines.push(`      params:  ${r.bitsPerSecond} bps, ${r.normalBurstBytes} limit, ${r.maxBurstBytes} extended limit`);
    lines.push(`      conformed ${r.conformedPackets} packets, ${r.conformedBytes} bytes; action: ${r.conformAction}`);
    lines.push(`      exceeded ${r.exceededPackets} packets, ${r.exceededBytes} bytes; action: ${r.exceedAction}`);
    const depuis = r.lastPacketMs === null ? 'never' : `${maintenant - r.lastPacketMs}ms ago`;
    lines.push(`      last packet: ${depuis}, current burst: ${Math.round(r.tokens)} bytes`);
  }
  return lines.join('\n');
}

export function showVlansRouter(router: Router): string {
  void router;
  return 'No Virtual LAN sub-interfaces are configured';
}

/**
 * `Port.getIPv6Addresses()` rend des ENTRÉES (adresse + longueur de
 * préfixe + origine), pas des chaînes. Les deux sites d'appel le
 * déclaraient `string[]` par coercition, ce qui a fait sortir
 * `[object Object]` dans le terminal : une coercition qui ment au
 * compilateur ne ment qu'à lui.
 */
function ipv6AddressStrings(port: import('../../../hardware/Port').Port): string[] {
  return port.getIPv6Addresses().map(e => (e.origin === 'link-local'
    ? `${e.address.withScopeId(null)}`
    : `${e.address}/${e.prefixLength}`));
}

/**
 * Une adresse de lien DÉRIVÉE de la MAC n'a pas été configurée : IOS ne
 * la rend pas, il la recalcule. Seule celle qu'un opérateur a posée
 * lui-même vaut une ligne, et c'est la comparaison avec l'EUI-64 qui
 * distingue les deux — sans nouvel état à porter.
 */
function runningConfigInterfaceIPv6(port: import('../../../hardware/Port').Port): string[] {
  const lines: string[] = [];
  if (port.isIPv6Enabled()) {
    const derivee = IPv6Address.fromMAC(port.getMAC()).toString();
    for (const e of port.getIPv6Addresses()) {
      if (e.origin === 'static') lines.push(` ipv6 address ${e.address}/${e.prefixLength}`);
      else if (e.origin === 'link-local' && `${e.address.withScopeId(null)}` !== derivee) {
        lines.push(` ipv6 address ${e.address.withScopeId(null)} link-local`);
      }
    }
    if (lines.length === 0) lines.push(' ipv6 enable');
  }
  const mtu = (port as unknown as { ipv6Mtu?: number }).ipv6Mtu;
  if (mtu !== undefined) lines.push(` ipv6 mtu ${mtu}`);
  return lines;
}

export function showIpv6InterfaceBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines: string[] = [];
  for (const [name, port] of ports) {
    const v6 = ipv6AddressStrings(port);
    const { status, protocol } = iosInterfaceStatus(port, name, ports);
    lines.push(`${name.padEnd(27)}[${status}/${protocol}]`);
    if (v6.length === 0) lines.push(`    unassigned`);
    else for (const a of v6) lines.push(`    ${a}`);
  }
  return lines.join('\n');
}

export function showIpv6Interface(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const v6 = ipv6AddressStrings(port);
  return [
    `${ifName} is ${iosInterfaceStatus(port, ifName, router._getPortsInternal()).status}, `
      + `line protocol is ${iosInterfaceStatus(port, ifName, router._getPortsInternal()).protocol}`,
    `  IPv6 is ${v6.length > 0 ? 'enabled' : 'disabled'}`,
    ...v6.map(a => `  Address: ${a}`),
    `  MTU is ${port.getMTU()} bytes`,
  ].join('\n');
}

/**
 * `show ipv6 neighbors`. The neighbour cache was real, complete and
 * unviewable: nothing anywhere in the repo rendered it, on either
 * vendor, so an operator had no way to tell an unresolved next hop from
 * an unreachable one.
 */
export function showIpv6Neighbors(router: Router, ifFilter?: string): string {
  const rows: Ipv6NeighborRow[] = [];
  // The cache stamps its entries with the SCHEDULER's clock, so an age
  // computed from the wall clock reports the epoch. One clock, not two.
  const nowMs = router.getNeighborCacheNow();
  for (const [ip, entry] of router.getNeighborCache()) {
    if (ifFilter && entry.iface !== ifFilter) continue;
    rows.push({
      address: displayIpv6Address(ip),
      age: entry.state === 'incomplete' ? '-' : String(Math.floor(Math.max(0, nowMs - entry.timestamp) / 60000)),
      mac: entry.mac.toCiscoString(),
      state: IPV6_NEIGHBOR_STATE_IOS[entry.state],
      iface: iosShortInterfaceName(entry.iface),
    });
  }
  rows.sort((a, b) => a.address.localeCompare(b.address));
  return renderTable(rows, IPV6_NEIGHBORS_COLUMNS, IPV6_NEIGHBORS_STYLE).join('\n');
}

/**
 * `show ipv6 traffic`. Every number is COUNTED by `IPv6DataPlane` at a
 * real point of its own code; the lines IOS also prints and this
 * simulator cannot observe — checksum errors (nothing verifies an
 * ICMPv6 checksum), fragments and reassembly (IPv6 fragmentation is not
 * modelled), source-routed (no routing header) — are left OUT rather
 * than shown as a zero nothing backs. A zero that IS counted stays: no
 * hop-limit expiry having happened is a measurement.
 */
export function showIpv6Traffic(router: Router): string {
  const c = router.getIpv6Counters();
  const icmpIn = c.icmpInEchoRequests + c.icmpInEchoReplies + c.ndInSolicits
    + c.ndInAdverts + c.ndInRouterSolicits;
  const icmpOut = c.icmpOutEchoReplies + c.icmpOutErrors + c.ndOutSolicits
    + c.ndOutAdverts + c.ndOutRouterAdverts;
  return [
    'IPv6 statistics:',
    `  Rcvd:  ${c.inReceives} total, ${c.inDelivers} local destination`,
    `         ${c.inHopLimitExceeded} hop count exceeded`,
    `         ${c.inNoRoutes} no route, ${c.inFiltered} access denied`,
    `  Sent:  ${c.outRequests} generated, ${c.outForwarded} forwarded`,
    `         ${c.outFiltered} access denied`,
    '',
    'ICMP statistics:',
    `  Rcvd: ${icmpIn} input`,
    `        ${c.icmpInEchoRequests} echo request, ${c.icmpInEchoReplies} echo reply`,
    `        ${c.ndInSolicits} neighbor solicit, ${c.ndInAdverts} neighbor advert`,
    `        ${c.ndInRouterSolicits} router solicit`,
    `  Sent: ${icmpOut} output`,
    `        ${c.icmpOutEchoReplies} echo reply, ${c.icmpOutErrors} errors`,
    `        ${c.ndOutSolicits} neighbor solicit, ${c.ndOutAdverts} neighbor advert`,
    `        ${c.ndOutRouterAdverts} router advert`,
  ].join('\n');
}

/**
 * `show ipv6 static` — the static routes alone, read from the same
 * table `show ipv6 route` renders.
 */
export function showIpv6Static(router: Router): string {
  const rt = (router._getIPv6RoutingTableInternal() ?? []) as Array<{
    type?: string; prefix?: { toString(): string }; prefixLength?: number;
    nextHop?: { toString(): string } | null; iface?: string; ad?: number;
  }>;
  const statiques = rt.filter((r) => r.type === 'static' || r.type === 'default');
  const lines = [`IPv6 Static routes`, `Code: * - installed in RIB`];
  for (const r of statiques) {
    const via = r.nextHop ? `via ${r.nextHop}` : `via ${r.iface ?? ''}`;
    lines.push(`*  ${r.prefix}/${r.prefixLength ?? 64} ${via}, distance ${r.ad ?? 1}`);
  }
  return lines.join('\n');
}

/**
 * IOS prints an address in upper case and WITHOUT its zone index here:
 * the zone is an interface name, not part of the 128 bits, and the
 * Interface column already names it. Upper-casing the whole string
 * turned `%GigabitEthernet0/0` into `%GIGABITETHERNET0/0`.
 */
function displayIpv6Address(ip: string): string {
  return ip.split('%')[0].toUpperCase();
}

/** IOS abbreviates every NDP state to five characters. */
const IPV6_NEIGHBOR_STATE_IOS: Record<string, string> = {
  incomplete: 'INCMP', reachable: 'REACH', stale: 'STALE',
  delay: 'DELAY', probe: 'PROBE',
};

export function showInterfacesAll(router: Router): string {
  const names = [...router._getPortsInternal().keys()];
  if (!names.length) return 'No interfaces present.';
  return names.map((n) => showInterface(router, n)).join('\n');
}

/** `show interfaces description` — real status/protocol/description table. */
export function renderInterfacesDescription(
  ports: ReadonlyMap<string, Port>,
  describe: (name: string) => string,
  nameOf: (name: string) => string = (n) => n,
): string {
  const rows = ['Interface                      Status         Protocol Description'];
  for (const [name, port] of ports) {
    const { status, protocol } = iosInterfaceStatus(port, name, ports);
    const shown = status === 'administratively down' ? 'admin down' : status;
    rows.push(`${nameOf(name).padEnd(31)}${shown.padEnd(15)}${protocol.padEnd(9)}${describe(name)}`);
  }
  return rows.join('\n');
}

export function showInterfacesDescription(router: Router): string {
  return renderInterfacesDescription(
    router._getPortsInternal(),
    (n) => router.getInterfaceDescription(n) || '',
  );
}

/**
 * Note sur `show interfaces status` : la commande n'existe PAS sur un
 * routeur IOS, qui répond `% Invalid input detected at '^' marker.` —
 * ce que ce simulateur fait déjà. Ce fichier en portait pourtant un
 * rendu complet, que rien n'appelait ; il est supprimé plutôt que
 * conservé, une seconde réponse possible à une question étant
 * exactement le défaut que le module de tableaux referme. La mise en
 * page réelle vit désormais dans `ciscoTableLayouts.ts` et sert au
 * commutateur, qui, lui, a la commande.
 */

/**
 * `show interfaces summary` — real per-port queue summary.
 *
 * L'en-tête et les lignes étaient deux chaînes indépendantes : les neuf
 * compteurs finissaient tous un caractère AVANT leur intitulé, et
 * chaque ligne traînait deux blancs de fin. Les largeurs ci-dessous
 * reproduisent au caractère près l'en-tête que cette commande écrivait
 * déjà — lui était juste, seules les données s'en écartaient — et
 * placent les compteurs à droite, comme IOS le fait pour des nombres.
 */
export function showInterfacesSummary(router: Router): string {
  const noms = [...router._getPortsInternal().keys()];
  const compteur = (w: number): TableColumn<string> =>
    ({ header: '', width: w, align: 'right', value: () => '0' });
  const colonnes: Array<TableColumn<string>> = [
    { header: 'Interface', width: 24, value: (n) => n },
    { ...compteur(4), header: 'IHQ' },
    { ...compteur(6), header: 'IQD' },
    { ...compteur(5), header: 'OHQ' },
    { ...compteur(6), header: 'OQD' },
    { ...compteur(6), header: 'RXBS' },
    { ...compteur(5), header: 'RXPS' },
    { ...compteur(6), header: 'TXBS' },
    { ...compteur(6), header: 'TXPS' },
    { ...compteur(6), header: 'TRTL' },
  ];
  const lignes = renderTable(noms, colonnes, { gap: 0, rule: false, indent: ' ' });
  // Le filet d'IOS part de la colonne 0, donc AVANT le retrait d'un
  // blanc que porte le reste du tableau : il n'est pas rendu par le
  // style `rule`, qui suivrait ce retrait.
  lignes.splice(1, 0, '-'.repeat(74));
  return lignes.join('\n');
}

/**
 * Le bloc L3 d'une interface, celui que `show ip interface` rend.
 *
 * `show ip interface <nom>` ne l'appelait pas : il renvoyait le rendu de
 * `show interfaces`, c'est-à-dire l'autre commande. Les deux existent
 * précisément parce qu'elles répondent à des questions différentes — la
 * première décrit le TRAITEMENT IP (adresse, broadcast, MTU IP, helper,
 * proxy ARP, commutation), la seconde décrit le lien (matériel,
 * encapsulation, compteurs de trames) — et les confondre privait la
 * plateforme de la moitié de la réponse.
 *
 * Le MTU et le proxy ARP sont LUS sur le port : ils étaient écrits en
 * dur (`MTU is 1500 bytes`, `Proxy ARP is enabled`), de sorte qu'un
 * `ip mtu`/`no ip proxy-arp` posé sur l'interface était affiché par
 * `show running-config` et nié par cette vue, sur la même machine au
 * même instant.
 */
/** L'agent NTP d'un routeur, quand il en a un. */
function ntpAgentOf(router: Router): import('@/network/ntp/NtpAgent').NtpAgent | undefined {
  return (router as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent }).getNtpAgent?.();
}

function ipInterfaceBlock(router: Router, name: string, port: Port): string {
  const nat = router._getNATEngine();
  const natTag = nat.isInsideInterface(name) ? ' (nat: inside)'
    : nat.isOutsideInterface(name) ? ' (nat: outside)' : '';
  const flags = (router as unknown as {
    [k: symbol]: { interfaceFlags?: Map<string, { noRedirects?: boolean; noUnreachables?: boolean }> } | undefined;
  })[Symbol.for('CiscoSecurityConfig')]?.interfaceFlags?.get(name) ?? {};
  const binding = router._getInterfaceACLBindingsInternal().get(name);
  return ipInterfaceBlockFor(name, port, router._getPortsInternal(), natTag,
    router.ripSplitHorizonOn(name), flags,
    { inbound: binding?.inbound, outbound: binding?.outbound });
}

export interface InterfaceAclRefs {
  inbound?: number | string | null;
  outbound?: number | string | null;
}

/**
 * Les deux lignes qui disent quelle liste filtre cette interface.
 *
 * Elles étaient CONSTANTES : `ip access-group 1 out` posé, la vue
 * répondait « not set » sur la même machine au même instant — la seule
 * commande qui répond à « où ma liste est-elle appliquée ? » ne lisait
 * pas la liaison. Une seule fonction, lue par le routeur ET par le
 * commutateur, physique comme SVI.
 */
export function interfaceAclLines(acl: InterfaceAclRefs): string[] {
  const dit = (ref: number | string | null | undefined) =>
    ref === null || ref === undefined ? 'not set' : String(ref);
  return [
    `  Outgoing access list is ${dit(acl.outbound)}`,
    `  Inbound  access list is ${dit(acl.inbound)}`,
  ];
}

export function ipInterfaceBlockFor(
  name: string,
  port: Port,
  ports: ReadonlyMap<string, Port>,
  natTag = '',
  splitHorizon = true,
  icmp: { noRedirects?: boolean; noUnreachables?: boolean } = {},
  acl: InterfaceAclRefs = {},
): string {
  const view = iosInterfaceStatus(port, name, ports);
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const lines = [
    `${name} is ${view.status}, line protocol is ${view.protocol}${natTag}`,
    ip
      ? `  Internet address is ${ip}${mask ? `/${mask.toCIDR()}` : ''}`
      : '  Internet protocol processing disabled',
  ];
  if (!ip) return lines.join('\n');
  lines.push('  Broadcast address is 255.255.255.255');
  lines.push(`  Address determined by ${iosAddressMethod(port) === 'DHCP' ? 'DHCP' : 'non-volatile memory'}`);
  lines.push(`  MTU is ${port.getMTU()} bytes`);
  lines.push('  Helper address is not set');
  lines.push('  Directed broadcast forwarding is disabled');
  lines.push(...interfaceAclLines(acl));
  lines.push(`  Proxy ARP is ${port.isProxyArpEnabled?.() === false ? 'disabled' : 'enabled'}`);
  lines.push('  Local Proxy ARP is disabled');
  lines.push('  Security level is default');
  lines.push(`  Split horizon is ${splitHorizon ? 'enabled' : 'disabled'}`);
  lines.push(`  ICMP redirects are ${icmp.noRedirects ? 'never sent' : 'always sent'}`);
  lines.push(`  ICMP unreachables are ${icmp.noUnreachables ? 'never sent' : 'always sent'}`);
  lines.push('  IP fast switching is enabled');
  lines.push('  IP CEF switching is enabled');
  return lines.join('\n');
}

/** `show ip interface` (all, verbose) — real per-port L3 state. */
export function showIpInterfaceAll(router: Router): string {
  const blocks: string[] = [];
  for (const [name, port] of router._getPortsInternal()) {
    blocks.push(ipInterfaceBlock(router, name, port));
  }
  return blocks.length ? blocks.join('\n') : 'No interfaces present.';
}

/** `show ip interface <nom>` — le même bloc, pour une seule interface. */
export function showIpInterfaceOne(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid input detected at '^' marker.`;
  return ipInterfaceBlock(router, ifName, port);
}

/** `show ip rip database` — real RIP RIB (configured + learned). */
export function showIpRipDatabase(router: Router, autoSummary = true): string {
  if (!router.isRIPEnabled()) return '';
  const cfg = router.getRIPConfig();
  const learned = router.getRIPRoutes();
  const lines: string[] = [];
  const summarized = new Set<string>();

  const summaryLine = (addr: IPAddress) => {
    if (!autoSummary) return;
    const mask = classfulMaskOf(addr);
    const key = `${addr.networkAddress(mask).toString()}/${mask.toCIDR()}`;
    if (summarized.has(key)) return;
    summarized.add(key);
    lines.push(`${key}    auto-summary`);
  };

  for (const [name, port] of router._getPortsInternal()) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    if (!ip || !mask) continue;
    if (!router.isRouteInterfaceUsable(name)) continue;
    if (!ripCoversAddress(cfg.networks, ip)) continue;
    summaryLine(ip);
    lines.push(`${ip.networkAddress(mask).toString()}/${mask.toCIDR()}    directly connected, ${name}`);
  }

  for (const [key, info] of learned) {
    const [netPart] = key.split('/');
    try { summaryLine(new IPAddress(netPart)); } catch { /* keep the entry */ }
    lines.push(`${key}`);
    lines.push(`    [${info.metric}] via ${info.learnedFrom}, ` +
      `${formatRipAge(info.age)}${info.garbageCollect ? ', possibly down' : ''}`);
  }
  return lines.join('\n');
}

function classfulMaskOf(addr: IPAddress): SubnetMask {
  const first = parseInt(addr.toString().split('.')[0], 10);
  if (first < 128) return new SubnetMask('255.0.0.0');
  if (first < 192) return new SubnetMask('255.255.0.0');
  return new SubnetMask('255.255.255.0');
}

function ripCoversAddress(
  networks: ReadonlyArray<{ network: IPAddress; mask: SubnetMask }>,
  addr: IPAddress,
): boolean {
  return networks.some((n) =>
    addr.networkAddress(n.mask).toString() === n.network.networkAddress(n.mask).toString());
}

function formatRipAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hh = String(Math.floor(s / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/** `show ip bgp …` — honest state: no BGP process configured. */
export function showBgpNotActive(): string {
  return '% BGP not active';
}

/** `show ip eigrp …` — honest state: no EIGRP process configured. */
export function showEigrpNotRunning(): string {
  return '% EIGRP not running (no autonomous-system configured)';
}

/**
 * Les blocs `line console 0` et `line aux 0`, rendus a partir du shell
 * qui les porte.
 *
 * Ils etaient ecrits DANS le rendu du routeur, donc le commutateur n'en
 * avait aucun : `line console 0` / `password` / `login` etaient acceptes
 * sur un Catalyst et ne paraissaient nulle part. Ce n'est pas qu'un
 * defaut d'affichage — la premiere securite qu'un cours fait poser
 * disparaissait, et la configuration rendue est ce qui REFAIT la
 * machine a l'import d'une topologie.
 */
export function consoleAndAuxLineConfigLines(
  device: unknown, serviceEncryption = false,
): string[] {
  const shell = (device as {
    shell?: {
      _getConsoleLineConfig?: () => unknown;
      _getAuxLineConfig?: () => unknown;
    };
  }).shell;
  const lines: string[] = [];

  const consoleCfg = shell?._getConsoleLineConfig?.() as null | {
    line: number;
    password: string | null;
    passwordEncrypted: boolean;
    login: 'password' | 'local' | 'none' | 'aaa' | null;
    loginAuthList: string | null;
    privilegeLevel: number | null;
    execTimeoutMin: number | null;
    execTimeoutSec: number;
    loggingSynchronous: boolean;
    historySize: number | null;
    historyEnabled: boolean;
  };
  if (consoleCfg) {
    lines.push(`line console ${consoleCfg.line}`);
    if (consoleCfg.password != null) {
      lines.push(` password ${renderPasswordField(
        consoleCfg.password, consoleCfg.passwordEncrypted ? 'type-7' : 'plain-password',
        serviceEncryption, false, 'line-console')}`);
    }
    if (consoleCfg.login === 'local') lines.push(' login local');
    else if (consoleCfg.login === 'aaa') {
      lines.push(` login authentication ${consoleCfg.loginAuthList ?? 'default'}`);
    } else if (consoleCfg.login === 'password') lines.push(' login');
    else if (consoleCfg.login === 'none') lines.push(' no login');
    if (consoleCfg.privilegeLevel != null) lines.push(` privilege level ${consoleCfg.privilegeLevel}`);
    if (consoleCfg.execTimeoutMin != null) {
      lines.push(` exec-timeout ${consoleCfg.execTimeoutMin} ${consoleCfg.execTimeoutSec}`);
    }
    if (consoleCfg.loggingSynchronous) lines.push(' logging synchronous');
    if (!consoleCfg.historyEnabled) lines.push(' no history');
    else if (consoleCfg.historySize != null) lines.push(` history size ${consoleCfg.historySize}`);
    lines.push('!');
  }

  const auxCfg = shell?._getAuxLineConfig?.() as null | {
    line: number;
    noExec: boolean;
    transportInput: 'ssh' | 'telnet' | 'all' | 'none' | null;
  };
  if (auxCfg) {
    lines.push(`line aux ${auxCfg.line}`);
    if (auxCfg.noExec) lines.push(' no exec');
    if (auxCfg.transportInput != null) lines.push(` transport input ${auxCfg.transportInput}`);
    lines.push('!');
  }
  return lines;
}

/**
 * `enable secret level N` / `enable password level N`.
 *
 * Le magasin vit sur `Equipment`, donc le commutateur le porte depuis
 * toujours — mais seul le rendu du ROUTEUR le lisait. Un
 * `enable secret level 7` pose sur un Catalyst fonctionnait, ouvrait
 * bien le niveau 7, et disparaissait de la configuration : perdu au
 * rechargement d'une topologie, donc le niveau intermediaire n'etait
 * plus accessible a personne apres un aller-retour.
 */
export function enableLevelSecretConfigLines(
  device: unknown, serviceEncryption: boolean,
): string[] {
  const store = device as {
    listEnableSecretLevels?: () => ReadonlyArray<{
      level: number; value: string;
      algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7';
    }>;
    listEnablePasswordLevels?: () => ReadonlyArray<{
      level: number; value: string; algo: 'plain' | 'type-7';
    }>;
  };
  const out: string[] = [];
  for (const e of store.listEnableSecretLevels?.() ?? []) {
    out.push(`enable secret level ${e.level} ${renderSecretField(e.value, e.algo, `enable:${e.level}`)}`);
  }
  for (const e of store.listEnablePasswordLevels?.() ?? []) {
    out.push(`enable password level ${e.level} ${renderPasswordField(e.value, e.algo, serviceEncryption, false, `enable:${e.level}`)}`);
  }
  return out;
}

export function hostsTableLines(device: unknown): string[] {
  const hosts = (device as { _getHostsTable?: () => { renderCisco: () => string[] } })
    ._getHostsTable?.();
  return hosts ? hosts.renderCisco() : [];
}

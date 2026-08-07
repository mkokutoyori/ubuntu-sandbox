/**
 * CiscoShowCommands - Extracted show command implementations for Cisco IOS CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by CiscoIOSShell for "show" commands in user and privileged modes.
 */

import type { Router } from '../../Router';
import { runningConfigACL, runningConfigInterfaceACL } from './CiscoAclCommands';
import { runningConfigNAT, runningConfigInterfaceNAT } from './CiscoNATCommands';
import { ipSlaRunningConfigLines, trackRunningConfigLines } from './ciscoIpSlaRunningConfig';
import { orderCiscoConfigBlocks, routingProcessConfigLines, policyConfigLines } from './ciscoConfigSerializer';
import { igmpInterfaceRunningConfigLines } from './CiscoIgmpCommands';

import { CISCO_HARDWARE_PROFILES, formatIosUptime, licenseTable, type CiscoChassisProfile } from './CiscoCommonShow';
import { renderSecretField, renderPasswordField, type SecretAlgo } from './ciscoPasswordRender';
import { formatInvalidInputAt } from '../CommandTrie';
import { iosInterfaceStatus, iosAddressMethod, iosShortInterfaceName } from '@/network/devices/inspection/InterfaceStatusView';

export function showVersion(router: Router, profile: CiscoChassisProfile = 'router-isr2911'): string {
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
    `Processor board ID ${hw.serialNumber}`,
    `${giPorts.length} Gigabit Ethernet interfaces`,
    `DRAM configuration is 64 bits wide with parity enabled.`,
    `${hw.nvramDisplayKB}K bytes of non-volatile configuration memory.`,
    '',
    `Configuration register is 0x2102`,
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
      defaults.push(`S*    0.0.0.0/0 [${r.ad ?? 1}/${r.metric ?? 0}] via ${r.nextHop}`);
      continue;
    }
    const attachee = !r.nextHop || String(r.nextHop) === '0.0.0.0';
    const via = attachee ? 'is directly connected' : `via ${r.nextHop}`;
    const metricStr = r.type === 'connected' || r.type === 'local'
      ? '' : ` [${r.ad ?? 1}/${r.metric ?? 0}]`;
    const suffix = r.type === 'static' && !attachee ? '' : `, ${r.iface}`;
    rendered.push({
      code: codeOverride?.(r) ?? routeCode(r.type),
      networkInt: r.network.toUint32 ? r.network.toUint32() : dottedToInt(r.network.toString()),
      prefixLength,
      text: `${r.network}/${prefixLength}${metricStr} ${via}${suffix}`,
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
    lines.push(masks.size > 1
      ? `      ${base}/${parentPrefix} is variably subnetted, ${bucket.length} subnets, ${masks.size} masks`
      : `      ${base}/${parentPrefix} is subnetted, ${bucket.length} subnets`);
    for (const entry of bucket) lines.push(`${entry.code.padEnd(2)}       ${entry.text}`);
  }
  for (const line of defaults) lines.push(line);

  return lines.join('\n');
}

export function showIpIntBrief(router: Router): string {
  const ports = router._getPortsInternal();
  const lines = ['Interface                  IP-Address      OK? Method Status                Protocol'];
  for (const [name, port] of ports) {
    const ip = port.getIPAddress()?.toString() || 'unassigned';
    const { status, protocol } = iosInterfaceStatus(port, name, ports);
    const method = iosAddressMethod(port).padEnd(6);
    lines.push(`${name.padEnd(27)}${ip.padEnd(16)}YES ${method} ${status.padEnd(22)}${protocol}`);
  }
  return lines.join('\n');
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
  } else if (!isLoopback) {
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
  const lines = [
    'Building configuration...',
    '',
    'Current configuration:',
    '!',
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

  const consoleCfg = shell?._getConsoleLineConfig?.() as null | {
    line: number;
    password: string | null;
    passwordEncrypted: boolean;
    login: 'password' | 'local' | 'none' | null;
    privilegeLevel: number | null;
    execTimeoutMin: number | null;
    execTimeoutSec: number;
    loggingSynchronous: boolean;
  };
  if (consoleCfg) {
    lines.push(`line console ${consoleCfg.line}`);
    if (consoleCfg.password != null) {
      lines.push(` password ${consoleCfg.passwordEncrypted ? '7 ' : ''}${consoleCfg.password}`);
    }
    if (consoleCfg.login === 'local') lines.push(' login local');
    else if (consoleCfg.login === 'password') lines.push(' login');
    else if (consoleCfg.login === 'none') lines.push(' no login');
    if (consoleCfg.privilegeLevel != null) lines.push(` privilege level ${consoleCfg.privilegeLevel}`);
    if (consoleCfg.execTimeoutMin != null) {
      lines.push(` exec-timeout ${consoleCfg.execTimeoutMin} ${consoleCfg.execTimeoutSec}`);
    }
    if (consoleCfg.loggingSynchronous) lines.push(' logging synchronous');
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

  if (dhcp.isEnabled()) {
    lines.push('service dhcp');
  }
  // IOS emits the exclusions ahead of the pools they carve out of.
  const excluded = dhcp.getExcludedRanges();
  for (const range of excluded) {
    if (range.start === range.end) {
      lines.push(`ip dhcp excluded-address ${range.start}`);
    } else {
      lines.push(`ip dhcp excluded-address ${range.start} ${range.end}`);
    }
  }
  const pools = dhcp.getAllPools();
  for (const [, pool] of pools) {
    lines.push('!');
    lines.push(`ip dhcp pool ${pool.name}`);
    if (pool.network && pool.mask) lines.push(` network ${pool.network} ${pool.mask}`);
    const routers = pool.defaultRouters?.length ? pool.defaultRouters : (pool.defaultRouter ? [pool.defaultRouter] : []);
    if (routers.length > 0) lines.push(` default-router ${routers.join(' ')}`);
    if (pool.dnsServers.length > 0) lines.push(` dns-server ${pool.dnsServers.join(' ')}`);
    if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
    const days = Math.floor(pool.leaseDuration / 86400);
    if (days !== 1) lines.push(` lease ${days}`);
  }

  lines.push('!');
  const descs = router._getInterfaceDescriptions();
  for (const [name, port] of ports) {
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
    if (ip && mask) lines.push(` ip address ${ip} ${mask}`);
    else if (!/^(Tunnel|Loopback|Vlan|BVI|Port-channel|Null)/i.test(name)) {
      lines.push(' no ip address');
    }
    for (const sec of port.getSecondaryIPs()) lines.push(` ip address ${sec.ip} ${sec.mask} secondary`);
    if (!port.getIsUp()) lines.push(` shutdown`);
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
    const sec = (router as unknown as {
      [s: symbol]: { asInterfaceRunningConfigLines?: (iface: string) => string[] } | undefined;
    })[Symbol.for('CiscoSecurityConfig')];
    if (sec?.asInterfaceRunningConfigLines) lines.push(...sec.asInterfaceRunningConfigLines(name));
    const nhrp = (router as unknown as { getNhrpService?: () => { asRunningConfigInterface: (n: string) => string[] } }).getNhrpService?.();
    if (nhrp) lines.push(...nhrp.asRunningConfigInterface(name));
    const nf = (router as unknown as { getNetflowService?: () => { asInterfaceRunningConfigLines: (n: string) => string[] } }).getNetflowService?.();
    if (nf) lines.push(...nf.asInterfaceRunningConfigLines(name));
    lines.push(...igmpInterfaceRunningConfigLines(router, name));
    // `rate-limit` (CAR historique) était STOCKÉ sur le port et rendu
    // nulle part : la commande était acceptée, absente de la
    // running-config, et sans vue pour la contredire. Le stockage
    // existait, il lui manquait ses deux portes.
    for (const r of (router.getCarPolicer(name)?.list() ?? [])) lines.push(` ${r.raw}`);
    const ospfExtra = (router as unknown as { _getOSPFExtraConfig?: () => { pendingIfConfig: Map<string, Record<string, unknown>> } })._getOSPFExtraConfig?.();
    const pending = ospfExtra?.pendingIfConfig.get(name);
    if (pending) {
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
    lines.push('!');
  }

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

  // Local AAA users (`username NAME privilege N secret …`).
  const serviceEncryption = router.getServiceFlags().get('password-encryption') === true;
  const listUsers = (router as unknown as {
    _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo?: SecretAlgo; factoryDefault?: boolean }>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router);
    if (users.length > 0) {
      lines.push('!');
      for (const u of users) {
        const algo = u.secretAlgo ?? 'md5';
        // `type-7`/`plain-password` come from the `password` keyword
        // (reversible or cleartext); everything else came from `secret`
        // (always hashed, or explicitly stored as type 0 by `secret 0`).
        const field = (algo === 'type-7' || algo === 'plain-password')
          ? `password ${renderPasswordField(u.secret, algo, serviceEncryption, true, `username:${u.name}`)}`
          : `secret ${renderSecretField(u.secret, algo, `username:${u.name}`)}`;
        lines.push(`username ${u.name} privilege ${u.privilege} ${field}`);
      }
    }
  }

  // VTY line configuration (exec-timeout, access-class, transport input, …)
  const vtyStore = (router as unknown as { _getVtyLineConfig?: () => { renderAllCisco: () => string[] } })._getVtyLineConfig?.();
  if (vtyStore) {
    const vtyLines = vtyStore.renderAllCisco();
    if (vtyLines.length > 0) {
      lines.push(...vtyLines);
    }
  }

  if (!router.isIpRoutingEnabled()) {
    lines.push('no ip routing');
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
  const levelStore = router as unknown as {
    listEnableSecretLevels?: () => ReadonlyArray<{ level: number; value: string; algo: 'plain' | 'md5' | 'sha256' | 'scrypt' | 'type-7' }>;
    listEnablePasswordLevels?: () => ReadonlyArray<{ level: number; value: string; algo: 'plain' | 'type-7' }>;
  };
  for (const e of levelStore.listEnableSecretLevels?.() ?? []) {
    lines.push(`enable secret level ${e.level} ${renderSecretField(e.value, e.algo, `enable:${e.level}`)}`);
  }
  for (const e of levelStore.listEnablePasswordLevels?.() ?? []) {
    lines.push(`enable password level ${e.level} ${renderPasswordField(e.value, e.algo, serviceEncryption, false, `enable:${e.level}`)}`);
  }
  for (const [name, on] of router.getServiceFlags()) {
    lines.push(`${on ? '' : 'no '}service ${name}`);
  }

  const mgmtForSsh = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (mgmtForSsh) {
    if (mgmtForSsh.domainName) lines.push(`ip domain-name ${mgmtForSsh.domainName}`);
    const ssh = mgmtForSsh.getSsh();
    if (ssh.enabled) {
      if (ssh.version !== 2) lines.push(`ip ssh version ${ssh.version}`);
      if (ssh.timeout !== 60) lines.push(`ip ssh time-out ${ssh.timeout}`);
      if (ssh.retries !== 3) lines.push(`ip ssh authentication-retries ${ssh.retries}`);
      const port = (ssh as unknown as { port?: number }).port ?? 22;
      if (port !== 22) lines.push(`ip ssh port ${port}`);
    }
  }

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
  const header = lines.slice(0, 4);
  const ordered = orderCiscoConfigBlocks(lines.slice(4));
  const assembled = [...header, ...ordered, 'end'];
  const body = assembled.slice(4).join('\n');
  assembled[2] = `Current configuration : ${new TextEncoder().encode(body).length + 1} bytes`;
  return assembled.join('\n');
}

export function showRunningConfigInterface(router: Router, ifName: string): string {
  const port = router.getPort(ifName);
  if (!port) return `% Invalid interface "${ifName}"`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const dhcp = router._getDHCPServerInternal();
  const lines = [
    'Building configuration...',
    '',
    // Remplacé une fois le corps connu : l'en-tête annonce une TAILLE,
    // pas le nom de ce qu'on affiche.
    '',
    '!',
    `interface ${ifName}`,
  ];
  const desc = router.getInterfaceDescription(ifName);
  if (desc) lines.push(` description ${desc}`);
  const enc = (port as unknown as { encapsulation?: { type: string; vlan?: number; native?: boolean } }).encapsulation;
  if (enc && enc.type) {
    lines.push(` encapsulation ${enc.type}${enc.vlan != null ? ' ' + enc.vlan : ''}${enc.native ? ' native' : ''}`);
  }
  if (ip && mask) {
    lines.push(` ip address ${ip} ${mask}`);
    for (const sec of port.getSecondaryIPs()) lines.push(` ip address ${sec.ip} ${sec.mask} secondary`);
  }
  if (!port.getIsUp()) lines.push(` shutdown`);
  for (const natLine of runningConfigInterfaceNAT(router, ifName)) lines.push(natLine);
  const helpers = dhcp.getHelperAddresses(ifName);
  for (const h of helpers) {
    lines.push(` ip helper-address ${h}`);
  }
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
    const normales = aires.filter(a => !a.isStub && !a.isNSSA).length;
    const stub = aires.filter(a => a.isStub && !a.isNSSA).length;
    const nssa = aires.filter(a => a.isNSSA).length;
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
    const cfg = router.getRIPConfig();
    const ripRoutes = router.getRIPRoutes();
    const block = [
      'Routing Protocol is "rip"',
      '  Version: 2',
      `  Update interval: ${cfg.updateInterval / 1000}s`,
      `  Route timeout: ${cfg.routeTimeout / 1000}s`,
      `  Garbage collection: ${cfg.gcTimeout / 1000}s`,
      `  Split horizon: ${cfg.splitHorizon ? 'enabled' : 'disabled'}`,
      `  Poisoned reverse: ${cfg.poisonedReverse ? 'enabled' : 'disabled'}`,
      '',
      '  Advertised networks:',
    ];
    for (const net of cfg.networks) {
      block.push(`    ${net.network}/${net.mask.toCIDR()}`);
    }
    block.push('');
    block.push(`  RIP learned routes: ${ripRoutes.size}`);
    for (const [key, info] of ripRoutes) {
      block.push(`    ${key} metric ${info.metric} via ${info.learnedFrom} (age ${info.age}s)${info.garbageCollect ? ' [gc]' : ''}`);
    }
    sections.push(block.join('\n'));
  }

  const ipv6Engine = (router as unknown as { isBGPEnabled?: () => boolean }).isBGPEnabled?.();
  if (ipv6Engine) {
    sections.push('Routing Protocol is "bgp"');
  }

  if (sections.length === 0) return 'No routing protocol is configured.';
  return sections.join('\n\n');
}

/** `show interfaces` (all) — real per-port detail for every interface. */
export function showInterfaceAccounting(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const c = port.getCounters();
  return [
    `${ifName}`,
    `                Protocol    Pkts In    Chars In    Pkts Out   Chars Out`,
    `                    IP    ${String(c.framesIn).padStart(8)} ${String(c.bytesIn).padStart(11)} ${String(c.framesOut).padStart(11)} ${String(c.bytesOut).padStart(11)}`,
  ].join('\n');
}

export function showInterfaceStats(router: Router, ifName: string): string {
  const port = router._getPortsInternal().get(ifName);
  if (!port) return `% Invalid interface ${ifName}`;
  const c = port.getCounters();
  return [
    `${ifName}`,
    `          Switching path    Pkts In    Chars In    Pkts Out   Chars Out`,
    `               Processor ${String(c.framesIn).padStart(10)} ${String(c.bytesIn).padStart(11)} ${String(c.framesOut).padStart(11)} ${String(c.bytesOut).padStart(11)}`,
    `             Route cache          0           0           0           0`,
    `      Distributed cache          0           0           0           0`,
    `                  Total ${String(c.framesIn).padStart(10)} ${String(c.bytesIn).padStart(11)} ${String(c.framesOut).padStart(11)} ${String(c.bytesOut).padStart(11)}`,
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
  return port.getIPv6Addresses().map(e => `${e.address}/${e.prefixLength}`);
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

export function showInterfacesAll(router: Router): string {
  const names = [...router._getPortsInternal().keys()];
  if (!names.length) return 'No interfaces present.';
  return names.map((n) => showInterface(router, n)).join('\n');
}

/** `show interfaces description` — real status/protocol/description table. */
export function showInterfacesDescription(router: Router): string {
  const rows = ['Interface                      Status         Protocol Description'];
  const ports = router._getPortsInternal();
  for (const [name, port] of ports) {
    const { status, protocol } = iosInterfaceStatus(port, name, ports);
    const desc = router.getInterfaceDescription(name) || '';
    const shown = status === 'administratively down' ? 'admin down' : status;
    rows.push(`${name.padEnd(31)}${shown.padEnd(15)}${protocol.padEnd(9)}${desc}`);
  }
  return rows.join('\n');
}

/** `show interfaces status` — real connected/notconnect/disabled table. */
export function showInterfacesStatus(router: Router): string {
  const rows = ['Port      Name               Status       Vlan       Duplex  Speed Type'];
  for (const [name, port] of router._getPortsInternal()) {
    const view = iosInterfaceStatus(port, name, router._getPortsInternal());
    const status = !view.adminUp ? 'disabled'
      : view.protocol === 'up' ? 'connected' : 'notconnect';
    const desc = (router.getInterfaceDescription(name) || '').slice(0, 17);
    rows.push(
      `${iosShortInterfaceName(name).padEnd(10)}${desc.padEnd(19)}${status.padEnd(13)}` +
      `${'routed'.padEnd(11)}${String(port.getDuplex()).padEnd(8)}` +
      `${String(port.getSpeed()).padEnd(6)}${name.startsWith('Gig') ? '1000BASE-T' : '10/100BaseTX'}`);
  }
  return rows.join('\n');
}

/** `show interfaces summary` — real per-port queue summary. */
export function showInterfacesSummary(router: Router): string {
  const rows = [
    ' Interface                IHQ   IQD  OHQ   OQD  RXBS RXPS  TXBS  TXPS  TRTL',
    '--------------------------------------------------------------------------',
  ];
  for (const name of router._getPortsInternal().keys()) {
    rows.push(` ${name.padEnd(24)}  0     0    0     0     0    0     0     0     0`);
  }
  return rows.join('\n');
}

/** `show ip interface` (all, verbose) — real per-port L3 state. */
export function showIpInterfaceAll(router: Router): string {
  const blocks: string[] = [];
  const nat = router._getNATEngine();
  for (const [name, port] of router._getPortsInternal()) {
    const view = iosInterfaceStatus(port, name, router._getPortsInternal());
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const natTag = nat.isInsideInterface(name) ? ' (nat: inside)'
      : nat.isOutsideInterface(name) ? ' (nat: outside)' : '';
    blocks.push([
      `${name} is ${view.status}, ` +
        `line protocol is ${view.protocol}${natTag}`,
      ip
        ? `  Internet address is ${ip}${mask ? `/${mask.toCIDR()}` : ''}`
        : '  Internet protocol processing disabled',
      '  Broadcast address is 255.255.255.255',
      '  MTU is 1500 bytes',
      '  ICMP redirects are always sent',
      '  Proxy ARP is enabled',
    ].join('\n'));
  }
  return blocks.length ? blocks.join('\n') : 'No interfaces present.';
}

/** `show ip rip database` — real RIP RIB (configured + learned). */
export function showIpRipDatabase(router: Router, autoSummary = true): string {
  if (!router.isRIPEnabled()) return '';
  const cfg = router.getRIPConfig();
  const learned = router.getRIPRoutes();
  const lines: string[] = [];
  for (const net of cfg.networks) {
    // L'entrée `auto-summary` EST le résumé classful : elle n'a pas lieu
    // d'être quand `no auto-summary` est configuré. Elle était imprimée
    // inconditionnellement, donc la vue contredisait la configuration
    // affichée par `show running-config` sur la même machine.
    if (autoSummary) lines.push(`${net.network}/${net.mask.toCIDR()}    auto-summary`);
    lines.push(`${net.network}/${net.mask.toCIDR()}`);
    lines.push('    [1] directly connected, via configured network');
  }
  for (const [key, info] of learned) {
    lines.push(`${key}`);
    lines.push(`    [${info.metric}] via ${info.learnedFrom}, ` +
      `${info.age}s${info.garbageCollect ? ', possibly down' : ''}`);
  }
  return lines.length ? lines.join('\n') : 'RIP routing database is empty';
}

/** `show ip cef` — real FIB derived from the routing table. */
export function showIpCef(router: Router): string {
  const rt = router.getRoutingTable();
  const lines = ['Prefix               Next Hop             Interface'];
  lines.push('0.0.0.0/0            no route');
  for (const r of rt) {
    const prefix = `${r.network}/${r.mask.toCIDR()}`;
    const nh = r.nextHop ? String(r.nextHop) : 'attached';
    lines.push(`${prefix.padEnd(21)}${nh.padEnd(21)}${r.iface}`);
  }
  return lines.join('\n');
}

/** `show ip bgp …` — honest state: no BGP process configured. */
export function showBgpNotActive(): string {
  return '% BGP not active';
}

/** `show ip eigrp …` — honest state: no EIGRP process configured. */
export function showEigrpNotRunning(): string {
  return '% EIGRP not running (no autonomous-system configured)';
}

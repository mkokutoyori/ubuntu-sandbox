/**
 * HuaweiDisplayCommands - Extracted display command implementations for Huawei VRP CLI
 *
 * Pure functions: Router → string (no side effects, no state mutation)
 * Used by HuaweiVRPShell for "display" commands.
 *
 * Also provides registerDisplayCommands() to wire them onto a CommandTrie.
 */

import type { Router } from '../../Router';
import type { CommandTrie } from '../CommandTrie';
import { vrpRenderOffset } from '@/cli/vendors/vrp/vrpClockFamily';
import { HuaweiDebugService } from '../../router/diag/HuaweiDebugService';
import { nqaRunningConfigLines } from './HuaweiNqaCommands';
import {
  getHuaweiRoutingExtras, getSwitchSecurityService,
} from '../../../equipment/RouterServiceCapabilities';
import { IPAddress, IPv6Address } from '../../../core/types';
import { renderTable, VRP_TABLE, type TableColumn } from '../cli/TextTable';
import type { IPv6AddressEntry } from '../../../hardware/Port';
import { huaweiCipher, huaweiIrreversibleCipher } from '@/crypto';
import { looksLikeIrreversibleCipher, looksLikeReversibleCipher } from '@/crypto/passwords/huawei';
import { resolveHuaweiInterfaceName as resolveHuaweiIfName, normaliserBlocsVrp, huaweiRipExtras, huaweiDisplayInterfaceName, HUAWEI_ERRORS } from '../cli-utils';
import { displayNtpServiceStatus, displayNtpServiceSessions, lignesConfigNtpVrp, displayNtpStatisticsPacket } from './huaweiNtpCommands';
import {
  AUCUN_GROUPE, groupesDeLInterface, lignesConfigVrrp,
  rendreDisplayVrrp, rendreDisplayVrrpBrief, rendreDisplayVrrpStatistics,
} from './huaweiVrrpViews';
import { iosInterfaceStatus } from '@/network/devices/inspection/InterfaceStatusView';
import {
  type LigneIpBrief, type LigneInterface, type LigneArp,
  protocoleVrp, protocoleSpoofe, rendreIpInterfaceBrief,
  rendreInterfaceBrief, rendreInterfaceDescription,
  huaweiMacAddress, rendreArp,
} from './huaweiTableLayouts';
import { runningConfigACL, runningConfigInterfaceACL } from './HuaweiAclCommands';
import { isInterfacePoolName } from './HuaweiDhcpCommands';
import {
  displayClock as commonDisplayClock,
  displayCpuUsage as commonDisplayCpuUsage,
  displayMemoryUsage as commonDisplayMemoryUsage,
  displayUsers as commonDisplayUsers,
  displayDevice as commonDisplayDevice,
  displayAlarm as commonDisplayAlarm,
  displayElabel as commonDisplayElabel,
  displayLicense as commonDisplayLicense,
  displayLogbuffer as commonDisplayLogbuffer,
  displayTrapbuffer as commonDisplayTrapbuffer,
  displayPatchInformation as commonDisplayPatchInformation,
  displayDiagnosticInformation as commonDisplayDiagnosticInformation,
} from './HuaweiCommonDisplay';
import {
  AR2220_HARDWARE_PROFILE, renderHardwareVersion,
} from './HuaweiHardwareProfile';
import { normVrpSeverity, VRP_SEVERITIES } from '../../router/management/InfoCenterConfig';
import { renderDisplayUserInterface } from './HuaweiUserInterfaceCommands';
import { getSessionRegistry, getVtyLineConfig } from '../../../equipment/RouterServiceCapabilities';
import { interfacePoolName } from './HuaweiDhcpCommands';

// ─── Display State Accessor (passed from shell) ─────────────────────
export interface HuaweiDisplayState {
  isDhcpEnabled(): boolean;
  isDhcpSnoopingEnabled(): boolean;
  renderLogbuffer?(seuil?: number | null): string;
}

// ─── Pure Display Functions ──────────────────────────────────────────

export function displayVersion(router: Router): string {
  return renderHardwareVersion(
    router._getHostnameInternal(),
    '0 days, 0 hours, 0 minutes',
    AR2220_HARDWARE_PROFILE,
  );
}

export function displayInterface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Wrong parameter found at '^' position.`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  // Une sixieme facon de calculer l'etat, et une liste d'interfaces
  // virtuelles ecrite a la main qui oubliait `Vlanif` et `NULL`.
  const st = iosInterfaceStatus(port, portName, router._getPortsInternal());
  const lines = [
    `${huaweiDisplayInterfaceName(portName)} current state : `
      + `${st.status === 'administratively down' ? 'Administratively DOWN' : st.status.toUpperCase()}`,
    `Line protocol current state : ${st.protocol.toUpperCase()}`
      + `${protocoleSpoofe(portName) && st.protocol === 'up' ? ' (spoofing)' : ''}`,
  ];

  const desc = router.getInterfaceDescription(portName);
  if (desc) lines.push(`Description: ${desc}`);

  // VRP ecrit le masque en longueur de prefixe, ici comme dans
  // `display ip interface` : les deux vues divergeaient.
  lines.push(`Internet Address is ${ip && mask ? `${ip}/${mask.toCIDR()}` : 'not configured'}`);

  // Tunnel-specific info
  const isTunnel = /^Tunnel/i.test(portName);
  if (isTunnel) {
    const extra = router._getOSPFExtraConfig();
    const pending = extra.pendingIfConfig?.get(portName) as any;
    if (pending?.tunnelSource) lines.push(`Tunnel source ${pending.tunnelSource}`);
    if (pending?.tunnelDest) lines.push(`Tunnel destination ${pending.tunnelDest}`);
    const ipsecEng = (router as any)._getIPSecEngineInternal?.();
    if (ipsecEng) {
      const tp = (ipsecEng as any).tunnelProtection?.get(portName);
      if (tp) lines.push(`Tunnel protection IPSec profile ${tp.profileName}${tp.shared ? ' shared' : ''}`);
    }
  }

  lines.push(
    `The Maximum Transmit Unit is 1500`,
    `Input:  0 packets, 0 bytes`,
    `Output: 0 packets, 0 bytes`,
  );

  return lines.join('\n');
}

export function displayIpPool(router: Router, poolName: string): string {
  const dhcp = router._getDHCPServerInternal();
  const pool = dhcp.getPool(poolName);
  if (!pool) return `Error: Pool "${poolName}" does not exist.`;

  const leaseDays = Math.floor(pool.leaseDuration / 86400);
  const leaseStr = leaseDays >= 1 ? `${leaseDays} day(s)` : `${pool.leaseDuration} seconds`;
  const lines = [
    `Pool-name      : ${pool.name}`,
    `Pool-No        : 0`,
    `Position       : Local`,
    `Status         : Unlocked`,
    `Gateway-list   : ${pool.defaultRouter || 'not configured'}`,
    `Network        : ${pool.network || 'not configured'}`,
    `Mask           : ${pool.mask || 'not configured'}`,
    `DNS-list       : ${pool.dnsServers.join(' ') || 'not configured'}`,
    `Domain-name    : ${pool.domainName || 'not configured'}`,
    `Lease          : ${leaseStr}`,
  ];
  return lines.join('\n');
}

export function displayIpPoolAll(router: Router): string {
  const dhcp = router._getDHCPServerInternal();
  const pools = [...dhcp.getAllPools().values()].filter(p => !isInterfacePoolName(p.name));
  if (pools.length === 0) return 'No DHCP pools configured.';
  const lines: string[] = [];
  for (const pool of pools) {
    lines.push(displayIpPool(router, pool.name));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function huaweiProtoName(r: { type: string }): string {
  switch (r.type) {
    case 'connected': return 'Direct';
    case 'rip': return 'RIP';
    case 'ospf': return 'OSPF';
    case 'eigrp': return 'EIGRP';
    case 'bgp': return 'BGP';
    case 'default': return 'Static';
    default: return 'Static';
  }
}

function huaweiDefaultPreference(type: string): number {
  switch (type) {
    case 'connected': return 0;
    case 'ospf': return 10;
    case 'rip': return 100;
    case 'bgp': return 255;
    default: return 60;
  }
}

function huaweiConnectedNextHop(router: Router, r: any): string {
  const port = router.getPort(r.iface);
  const ip = port?.getIPAddress?.();
  if (ip) return ip.toString();
  return '127.0.0.1';
}

function renderHuaweiRouteRows(router: Router, table: any[]): string[] {
  const rows: string[] = [];
  for (const r of table) {
    const dest = `${r.network}/${r.mask.toCIDR()}`.padEnd(19);
    const proto = huaweiProtoName(r).padEnd(8);
    const pref = r.preference ?? huaweiDefaultPreference(r.type);
    const pre = String(pref).padEnd(5);
    const cost = String(r.metric ?? 0).padEnd(6);
    const flags = (r.type === 'connected' ? 'D' : 'RD').padEnd(6);
    let nh: string;
    if (r.type === 'connected') nh = huaweiConnectedNextHop(router, r);
    else if (r.nextHop) nh = r.nextHop.toString();
    else nh = '0.0.0.0';
    rows.push(`${dest} ${proto}${pre}${cost}${flags}${nh.padEnd(16)}${r.iface}`);
  }
  return rows;
}

/**
 * La table telle qu'un VRP la montre : seulement les routes RÉELLEMENT
 * installées.
 *
 * Ces vues lisaient `getRoutingTable()` brut, sans jamais demander si la
 * route était utilisable — si bien qu'une statique survivait à un
 * `shutdown` de son interface de sortie sur Huawei alors qu'elle
 * disparaissait sur Cisco, pour la même topologie et le même défaut.
 * Mesuré avant correction, et le piège est là : la forme `permanent`
 * semblait juste (la route restait), mais la forme ORDINAIRE restait
 * aussi — rien ne filtrait, la conformité apparente était un hasard.
 */
function installedRoutes(router: Router) {
  return router.getRoutingTable().filter((r) => router.isRouteUsable(r));
}

/**
 * La queue d'une ligne `ip route-static` : cible, préférence,
 * `permanent` — même correction que côté IOS et pour la même raison,
 * une configuration relue REFAIT la route au lieu de la décrire. VRP
 * écrit la distance derrière le mot-clé `preference`, contrairement à
 * IOS qui la pose nue.
 */
function vrpStaticRouteTail(r: {
  nextHop: { toString(): string } | null; iface: string;
  ifaceConfigured?: boolean; preference?: number; permanent?: boolean;
}): string {
  const nh = r.nextHop ? r.nextHop.toString() : '';
  const parts: string[] = [];
  if (r.ifaceConfigured && r.iface) {
    parts.push(r.iface);
    if (nh && nh !== '0.0.0.0') parts.push(nh);
  } else {
    parts.push(nh);
  }
  if (r.preference !== undefined) parts.push('preference', String(r.preference));
  if (r.permanent) parts.push('permanent');
  return parts.join(' ');
}

export function displayIpRoutingTable(router: Router): string {
  const table = installedRoutes(router);
  const destSet = new Set(table.map(r => `${r.network}/${r.mask.toCIDR()}`));
  const lines = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    'Routing Tables: Public',
    `         Destinations : ${destSet.size}        Routes : ${table.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];
  lines.push(...renderHuaweiRouteRows(router, table));
  return lines.join('\n');
}

export function displayIpRoutingTableProtocol(router: Router, proto: string): string {
  const wanted = proto.toLowerCase();
  const table = installedRoutes(router).filter(r => {
    const name = huaweiProtoName(r).toLowerCase();
    if (wanted === 'direct') return r.type === 'connected';
    if (wanted === 'static') return r.type === 'static' || r.type === 'default';
    return name === wanted;
  });
  const destSet = new Set(table.map(r => `${r.network}/${r.mask.toCIDR()}`));
  const head = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    `Public routing table : ${proto.toUpperCase()}`,
    `         Destinations : ${destSet.size}        Routes : ${table.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];
  return [...head, ...renderHuaweiRouteRows(router, table)].join('\n');
}

export function displayIpRoutingTableForDest(router: Router, dest: string): string {
  const table = installedRoutes(router);
  const targetInt = (() => {
    try { return new IPAddress(dest).toUint32(); } catch { return null; }
  })();
  if (targetInt === null) return `Error: Invalid IP address ${dest}`;
  const matches = table.filter(r => {
    const net = r.network.toUint32();
    const mask = r.mask.toUint32();
    return (targetInt & mask) === (net & mask);
  });
  if (matches.length === 0) return `Route does not exist.`;
  const head = [
    'Route Flags: R - relay, D - download to fib',
    '------------------------------------------------------------------------------',
    `Routing Table : Public`,
    `Summary Count : ${matches.length}`,
    '',
    'Destination/Mask    Proto   Pre  Cost  Flags NextHop         Interface',
  ];
  return [...head, ...renderHuaweiRouteRows(router, matches)].join('\n');
}

export function displayIpIntBrief(router: Router, filtre?: string): string {
  const ports = router._getPortsInternal();
  const lignes: LigneIpBrief[] = [];
  for (const [name, port] of ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    const { phys, proto } = vrpEtatPort(port, name, router._getPortsInternal());
    const nom = huaweiDisplayInterfaceName(name);
    lignes.push({
      nom,
      adresse: ip && mask ? `${ip}/${mask.toCIDR()}` : 'unassigned',
      physique: phys,
      protocole: protocoleVrp(nom, proto),
    });
  }
  if (filtre !== undefined) {
    // L'argument etait LU puis jete : `display ip interface brief
    // GigabitEthernet0/0/0` rendait tout le tableau, et un nom qui
    // n'existe pas aussi.
    const cible = resolveHuaweiInterfaceName(router, filtre);
    if (!cible) return `Error: Wrong parameter found at '^' position.`;
    const attendu = huaweiDisplayInterfaceName(cible);
    return rendreIpInterfaceBrief(lignes.filter((l) => l.nom === attendu));
  }
  return rendreIpInterfaceBrief(lignes);
}

export function displayIpInterface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName);
  const port = portName ? router.getPort(portName) : null;
  if (!port || !portName) return `Error: Wrong parameter found at '^' position.`;
  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  // Cette vue calculait l'etat a sa facon (`getIsUp()`/`isConnected()`),
  // d'ou un LoopBack rendu DOWN ici et UP par `display interface` sur la
  // meme machine au meme instant. Un objet, un etat, une source.
  const st = iosInterfaceStatus(port, portName, router._getPortsInternal());
  const lines = [
    `${huaweiDisplayInterfaceName(portName)} current state : `
      + `${st.status === 'administratively down' ? 'Administratively DOWN' : st.status.toUpperCase()}`,
    `Line protocol current state : ${st.protocol.toUpperCase()}`
      + `${protocoleSpoofe(portName) && st.protocol === 'up' ? ' (spoofing)' : ''}`,
    `Internet Address is ${ip && mask ? `${ip}/${mask.toCIDR()}` : 'unassigned'}`,
    `Broadcast address : ${ip && mask ? ip.broadcastAddress(mask).toString() : '0.0.0.0'}`,
    `The Maximum Transmit Unit : 1500 bytes`,
    `Input bandwidth utilization  : 0%`,
    `Output bandwidth utilization : 0%`,
    `    Last 300 seconds input rate 0 bits/sec, 0 packets/sec`,
    `    Last 300 seconds output rate 0 bits/sec, 0 packets/sec`,
    `    Input:  0 packets, 0 bytes`,
    `    Output: 0 packets, 0 bytes`,
  ];
  return lines.join('\n');
}

/** `display interface` (all) — real per-port detail. */
export function displayInterfaceAll(router: Router): string {
  const names = [...router._getPortsInternal().keys()];
  if (!names.length) return 'No interfaces present.';
  return names.map((n) => displayInterface(router, n)).join('\n');
}


/**
 * L'etat d'un port pour les vues VRP.
 *
 * Chaque vue calculait le sien (`getIsUp() && isConnected()`), ce qui se
 * trompe de trois facons : une porteuse tombee a l'autre bout n'est pas
 * vue, `administratively down` est aplati, et une interface VIRTUELLE —
 * qui n'a pas de porteuse — est declaree morte alors que sa route est
 * installee. `iosInterfaceStatus` decrit l'etat d'un PORT, pas un modele
 * par constructeur : les deux CLI le lisent maintenant, chacun avec ses
 * mots.
 */
function vrpEtatPort(port: import('../../../hardware/Port').Port, nom: string,
  ports?: ReadonlyMap<string, import('../../../hardware/Port').Port>): { phys: string; proto: string } {
  const st = iosInterfaceStatus(port, nom, ports);
  return {
    phys: st.status === 'administratively down' ? '*down' : st.status,
    proto: st.protocol,
  };
}

/**
 * `display interface brief`.
 *
 * Mise en page relevée sur du texte capturé sur de vraies machines (jeu
 * de référence `huawei_vrp/display_interface_brief` de
 * `ntc-templates`) :
 *
 * ```
 * Interface                   PHY   Protocol  InUti OutUti   inErrors  outErrors
 * Aux0/0/1                    down  down         0%     0%          0          0
 * Eth-Trunk4                  up    down      0.69% 13.57%       4625          0
 * ```
 *
 * Deux écarts que la mesure a montrés et que l'œil ne voyait pas : la
 * colonne `PHY` était large de huit caractères au lieu de six — donc
 * TOUT ce qui suit était décalé de deux — et les quatre colonnes de
 * droite étaient écrites à la main, chacune avec son propre décompte,
 * si bien que `outErrors` finissait un caractère après son intitulé.
 * Les quatre compteurs sont alignés à DROITE sur la vraie machine.
 */
export function displayInterfaceBrief(router: Router, filtre?: string): string {
  const lignes = lignesInterfaceVrp(router);
  const retenues = filtrerInterfaces(router, lignes, filtre);
  return typeof retenues === 'string' ? retenues : rendreInterfaceBrief(retenues);
}

/** Les lignes de la famille « brief », une seule fois pour ses deux vues. */
function lignesInterfaceVrp(router: Router): LigneInterface[] {
  const ports = router._getPortsInternal();
  const out: LigneInterface[] = [];
  for (const [name, port] of ports) {
    const { phys, proto } = vrpEtatPort(port, name, ports);
    out.push({
      nom: huaweiDisplayInterfaceName(name),
      physique: phys,
      protocole: proto,
      description: router.getInterfaceDescription(name) || '',
    });
  }
  return out;
}

/**
 * Le filtre par interface. Il etait LU puis jete : `display interface
 * brief GigabitEthernet0/0/0` rendait tout le tableau, et un nom qui
 * n'existe pas aussi.
 */
function filtrerInterfaces(
  router: Router, lignes: LigneInterface[], filtre?: string,
): LigneInterface[] | string {
  if (filtre === undefined || filtre === '') return lignes;
  const cible = resolveHuaweiInterfaceName(router, filtre);
  if (!cible) return `Error: Wrong parameter found at '^' position.`;
  const attendu = huaweiDisplayInterfaceName(cible);
  return lignes.filter((l) => l.nom === attendu);
}

/** `display interface description` — real description table. */
export function displayInterfaceDescription(router: Router, filtre?: string): string {
  const retenues = filtrerInterfaces(router, lignesInterfaceVrp(router), filtre);
  return typeof retenues === 'string' ? retenues : rendreInterfaceDescription(retenues);
}

export function displayArp(router: Router): string {
  const arpTable = router._getArpTableInternal();
  const lignes: LigneArp[] = [];
  for (const [ip, entry] of arpTable) {
    const age = Math.floor((Date.now() - entry.timestamp) / 60000);
    const type = (entry as { type?: string }).type === 'static' ? 'static' : 'D';
    lignes.push({ ip, mac: huaweiMacAddress(entry.mac), expire: String(age), type,
      iface: huaweiDisplayInterfaceName(entry.iface) });
  }
  return rendreArp(lignes, 'No ARP entries found.');
}

export function displayArpFiltered(router: Router, filterType: 'static' | 'dynamic'): string {
  const arpTable = router._getArpTableInternal();
  const lignes: LigneArp[] = [];
  for (const [ip, entry] of arpTable) {
    const isStatic = (entry as any).type === 'static';
    if (filterType === 'static' && !isStatic) continue;
    if (filterType === 'dynamic' && isStatic) continue;
    const age = Math.floor((Date.now() - entry.timestamp) / 60000);
    const type = isStatic ? 'static' : 'D';
    lignes.push({ ip, mac: huaweiMacAddress(entry.mac), expire: String(age), type,
      iface: huaweiDisplayInterfaceName(entry.iface) });
  }
  return rendreArp(lignes, `No ${filterType} ARP entries found.`);
}

export function displayArpInterface(router: Router, ifName: string): string {
  const arpTable = router._getArpTableInternal();
  const lignes: LigneArp[] = [];
  for (const [ip, entry] of arpTable) {
    const et = (entry as { type?: string }).type;
    if (entry.iface !== ifName && !entry.iface.endsWith(ifName)) continue;
    const age = Math.floor((Date.now() - entry.timestamp) / 60000);
    const type = et === 'static' ? 'static' : 'D';
    lignes.push({ ip, mac: huaweiMacAddress(entry.mac), expire: String(age), type,
      iface: huaweiDisplayInterfaceName(entry.iface) });
  }
  return rendreArp(lignes, 'No ARP entries found.');
}

export function displayArpStatistics(router: Router): string {
  const arpTable = router._getArpTableInternal();
  let stat = 0, dyn = 0;
  for (const [, entry] of arpTable) {
    if ((entry as { type?: string }).type === 'static') stat++; else dyn++;
  }
  return [
    `Total:${arpTable.size}        Dynamic:${dyn}        Static:${stat}`,
    `Interface:0        OpenFlow:0`,
  ].join('\n');
}

export function displayIpRoutingTableStatistics(router: Router): string {
  const table = router.getRoutingTable();
  const counts: Record<string, number> = {};
  for (const r of table) {
    const proto = r.type === 'connected' ? 'Direct' : r.type === 'rip' ? 'RIP' : r.type === 'ospf' ? 'OSPF' : 'Static';
    counts[proto] = (counts[proto] || 0) + 1;
  }
  const lines = [
    'Proto     route',
    '--------------------',
  ];
  let total = 0;
  for (const [proto, count] of Object.entries(counts)) {
    lines.push(`${proto.padEnd(10)}${count}`);
    total += count;
  }
  lines.push('--------------------');
  lines.push(`Total     ${total}`);
  return lines.join('\n');
}

export function displayCurrentConfig(
  router: Router,
  dhcpEnabled: boolean,
  dhcpSnoopingEnabled: boolean,
): string {
  const ports = router._getPortsInternal();
  const table = router._getRoutingTableInternal();
  const lines = [
    '#',
    `sysname ${router._getHostnameInternal()}`,
    '#',
  ];

  const dnsCfg = router._getDnsConfig();
  const dnsLignes: string[] = [];
  if (dnsCfg.lookupEnabled) dnsLignes.push('dns resolve');
  for (const s of dnsCfg.nameServers) dnsLignes.push(`dns server ${s}`);
  for (const d of dnsCfg.domainList) dnsLignes.push(`dns domain ${d}`);
  for (const e of router._getHostsTable().entries()) {
    if (e.permanent) dnsLignes.push(`ip host ${e.name} ${e.ips.join(' ')}`);
  }
  if (dnsLignes.length > 0) {
    lines.push(...dnsLignes);
    lines.push('#');
  }

  if (dhcpEnabled) {
    lines.push('dhcp enable');
    lines.push('#');
  }
  if (dhcpSnoopingEnabled) {
    lines.push('dhcp snooping enable');
    lines.push('#');
  }

  // DHCP pool config
  const dhcp = router._getDHCPServerInternal();
  for (const [, pool] of dhcp.getAllPools()) {
    if (isInterfacePoolName(pool.name)) continue;
    lines.push(`ip pool ${pool.name}`);
    if (pool.network && pool.mask) lines.push(` network ${pool.network} mask ${pool.mask}`);
    if (pool.defaultRouter) lines.push(` gateway-list ${pool.defaultRouter}`);
    if (pool.dnsServers.length > 0) lines.push(` dns-list ${pool.dnsServers.join(' ')}`);
    if (pool.domainName) lines.push(` domain-name ${pool.domainName}`);
    const days = Math.floor(pool.leaseDuration / 86400);
    const remSecs = pool.leaseDuration % 86400;
    const hours = Math.floor(remSecs / 3600);
    const mins = Math.floor((remSecs % 3600) / 60);
    if (pool.leaseDuration !== 86400) {
      let leaseStr = ` lease day ${days}`;
      if (hours > 0) leaseStr += ` hour ${hours}`;
      if (mins > 0) leaseStr += ` minute ${mins}`;
      lines.push(leaseStr);
    }
    lines.push('#');
  }
  const excluded = dhcp.getExcludedRanges();
  for (const range of excluded) {
    if (range.start === range.end) {
      lines.push(`dhcp server forbidden-ip ${range.start}`);
    } else {
      lines.push(`dhcp server forbidden-ip ${range.start} ${range.end}`);
    }
  }

  // ARP static entries
  const arpTable = router._getArpTableInternal();
  for (const [ip, entry] of arpTable) {
    if ((entry as any).type === 'static') {
      lines.push(`arp static ${ip} ${huaweiMacAddress(entry.mac)}`);
    }
  }

  const prefixV4 = router.getIpPrefixListStore().renderHuawei('ipv4');
  if (prefixV4) { lines.push(...prefixV4.split('\n')); lines.push('#'); }
  const prefixV6 = router.getIpPrefixListStore().renderHuawei('ipv6');
  if (prefixV6) { lines.push(...prefixV6.split('\n')); lines.push('#'); }
  const politiques = router.getRoutePolicyStore().renderHuawei();
  if (politiques) { lines.push(...politiques.split('\n')); lines.push('#'); }
  const mqc = router.getTrafficPolicyStore().renderHuawei();
  if (mqc.length > 0) lines.push(...mqc);

  const trLignes = vrpTimeRangeLines(router);
  if (trLignes.length > 0) { lines.push(...trLignes); lines.push('#'); }

  const aclAvant = runningConfigACL(router);
  if (aclAvant.length > 0) lines.push(...aclAvant);
  const natAvant = vrpNatGlobalLines(router);
  if (natAvant.length > 0) { lines.push(...natAvant); lines.push('#'); }

  const descs = router._getInterfaceDescriptions();
  const ospfExtra = router._getOSPFExtraConfig();
  for (const [name, port] of ports) {
    const ip = port.getIPAddress();
    const mask = port.getSubnetMask();
    // Real VRP renders the canonical interface name (GigabitEthernet*)
    // rather than the abbreviated 'GE*' device label.
    const renderedName = huaweiDisplayInterfaceName(name);
    lines.push(`interface ${renderedName}`);
    const desc = descs.get(name);
    if (desc) lines.push(` description ${desc}`);
    if (port.isDhcpClient()) {
      lines.push(' ip address dhcp-alloc');
    } else if (ip && mask) {
      lines.push(` ip address ${ip} ${mask}`);
    } else {
      lines.push(` shutdown`);
    }
    lines.push(...renderHuaweiInterfaceExtras(router, port, name));
    lines.push('#');
  }

  for (const r of table) {
    if (r.type === 'static' && r.nextHop) {
      lines.push(`ip route-static ${r.network} ${r.mask} ${vrpStaticRouteTail(r)}`);
    }
    if (r.type === 'default' && r.nextHop) {
      lines.push(`ip route-static 0.0.0.0 0.0.0.0 ${vrpStaticRouteTail(r)}`);
    }
  }
  // RIP config
  if (router.isRIPEnabled()) {
    lines.push('#');
    lines.push('rip 1');
    // La version etait ecrite en dur : un routeur en `version 1`
    // revenait en `version 2` apres rechargement.
    lines.push(` version ${(router as unknown as { _ripVersion?: number })._ripVersion ?? 2}`);
    if (huaweiRipExtras(router).autoSummary === false) lines.push(' undo summary');
    // `maximum load-balancing` n'etait rendu nulle part, sur AUCUN des
    // quatre protocoles : une configuration rejouee a l'import perdait
    // donc le plafond d'ECMP.
    const ripMax = huaweiRipExtras(router).maximumPaths;
    if (ripMax !== undefined) lines.push(` maximum load-balancing ${ripMax}`);
    const cfg = router.getRIPConfig();
    for (const net of cfg.networks) {
      lines.push(` network ${net.network}`);
    }
  }
  // OSPF config
  const ospf = router._getOSPFEngineInternal();
  if (ospf) {
    const config = ospf.getConfig();
    lines.push('#');
    lines.push(`ospf ${config.processId}`);
    if (config.routerId && config.routerId !== '0.0.0.0') {
      lines.push(` router-id ${config.routerId}`);
    }
    const ospfMax = (router._getOSPFExtraConfig() as { maximumPaths?: number }).maximumPaths;
    if (ospfMax !== undefined) lines.push(` maximum load-balancing ${ospfMax}`);
    // Group network statements by area
    const areaNetworks = new Map<string, Array<{ network: string; wildcard: string }>>();
    for (const net of config.networks) {
      if (!areaNetworks.has(net.areaId)) areaNetworks.set(net.areaId, []);
      areaNetworks.get(net.areaId)!.push({ network: net.network, wildcard: net.wildcard });
    }
    for (const [areaId, nets] of areaNetworks) {
      lines.push(` area ${areaId}`);
      for (const net of nets) {
        lines.push(`  network ${net.network} ${net.wildcard}`);
      }
    }
  }

  // IPSec/IKE configuration
  const ipsecEng = (router as any)._getIPSecEngineInternal?.() ?? null;
  if (ipsecEng) {
    const isakmpPolicies: Map<number, any> = (ipsecEng as any).isakmpPolicies;
    for (const [n, policy] of isakmpPolicies) {
      lines.push('#');
      lines.push(`ike proposal ${n}`);
      if (policy.huaweiEncryption) lines.push(` encryption-algorithm ${policy.huaweiEncryption}`);
      if (policy.hash) lines.push(` authentication-algorithm ${policy.hash}`);
      if (policy.group) lines.push(` dh group${policy.group}`);
    }
    const kr: any = (ipsecEng as any).ikev2Keyrings?.get('default');
    if (kr) {
      for (const [peerName, peer] of kr.peers as Map<string, any>) {
        lines.push('#');
        lines.push(`ike peer ${peerName}`);
        if (peer.address && peer.address !== '0.0.0.0') lines.push(` remote-address ${peer.address}`);
        if (peer.preSharedKey) lines.push(` pre-shared-key simple ${peer.preSharedKey}`);
      }
    }
    const transformSets: Map<string, any> = (ipsecEng as any).transformSets;
    for (const [name, ts] of transformSets) {
      lines.push('#');
      lines.push(`ipsec proposal ${name}`);
      if ((ts as any).protocol) lines.push(` transform ${(ts as any).protocol}`);
      if (ts.mode) lines.push(` encapsulation-mode ${ts.mode}`);
      const espEnc = ts.transforms.find((t: string) => t.match(/^esp-(aes|des|3des)/));
      if (espEnc) lines.push(` esp encryption-algorithm ${espEnc.replace('esp-', '')}`);
      const espAuth = ts.transforms.find((t: string) => t.includes('-hmac'));
      if (espAuth) {
        const algo = espAuth.replace('esp-', '').replace('-hmac', '');
        lines.push(` esp authentication-algorithm ${algo}`);
      }
    }
    const cryptoMaps: Map<string, any> = (ipsecEng as any).cryptoMaps;
    for (const [mapName, cmap] of cryptoMaps) {
      for (const [seq, entry] of cmap.staticEntries as Map<number, any>) {
        lines.push('#');
        lines.push(`ipsec policy ${mapName} ${seq} isakmp`);
        const peerRef = entry.ikePeerName ?? (entry.peers?.length > 0 ? entry.peers[0] : null);
        if (peerRef) lines.push(` ike-peer ${peerRef}`);
        if (entry.transformSets?.length > 0) lines.push(` proposal ${entry.transformSets.join(' ')}`);
      }
    }
    const ipsecProfiles: Map<string, any> = (ipsecEng as any).ipsecProfiles;
    for (const [profName, prof] of ipsecProfiles) {
      lines.push('#');
      lines.push(`ipsec profile ${profName}`);
      if (prof.transformSetName) lines.push(` proposal ${prof.transformSetName}`);
    }
  }

  // user-interface vty <range> blocks — idle-timeout, acl, protocol, …
  const vtyStore = (router as unknown as { _getVtyLineConfig?: () => { renderAllHuawei: () => string[] } })._getVtyLineConfig?.();
  if (vtyStore) {
    const vty = vtyStore.renderAllHuawei();
    if (vty.length > 0) lines.push(...vty);
  }

  const listUsers = (router as unknown as {
    _listLocalUsers?: () => ReadonlyArray<{ name: string; privilege: number; secret: string; secretAlgo?: string; factoryDefault?: boolean; serviceTypes?: readonly string[] }>;
  })._listLocalUsers;
  if (listUsers) {
    const users = listUsers.call(router);
    const p = router.getHuaweiAaaService().passwordPolicy;
    const hasPasswordPolicy = Object.keys(p).length > 0;
    if (users.length > 0 || hasPasswordPolicy) {
      lines.push('aaa');
      if (p.level) lines.push(` password-policy level ${p.level}`);
      if (p.minLength) lines.push(` password-policy min-length ${p.minLength}`);
      if (p.expireDays) lines.push(` password-policy expire ${p.expireDays}`);
      if (p.alertBeforeExpireDays) lines.push(` password-policy alert-before-expire ${p.alertBeforeExpireDays}`);
      if (p.historyMaxRecords) lines.push(` password-policy history-record max-record-number ${p.historyMaxRecords}`);
      for (const u of users) {
        // Real VRP never echoes the cleartext: 'cipher' is reversible
        // (AES), everything else is hashed one-way (irreversible-cipher).
        // Le secret RANGE est deja sous sa forme rendue depuis que le
        // parseur reconnait la valeur transformee ; le re-transformer
        // ici donnait un texte que le rejeu ne pouvait pas reproduire.
        const field = u.secretAlgo === 'cipher'
          ? `password cipher ${looksLikeReversibleCipher(u.secret) ? u.secret : huaweiCipher(u.secret)}`
          : `password irreversible-cipher ${looksLikeIrreversibleCipher(u.secret) ? u.secret : huaweiIrreversibleCipher(u.secret)}`;
        lines.push(` local-user ${u.name} ${field}`);
        lines.push(` local-user ${u.name} privilege level ${u.privilege}`);
        const types = u.serviceTypes && u.serviceTypes.length > 0 ? u.serviceTypes : ['ssh'];
        lines.push(` local-user ${u.name} service-type ${types.join(' ')}`);
      }
      lines.push('#');
    }
  }

  const routingExtras = getHuaweiRoutingExtras(router);
  if (routingExtras) {
    const rl = routingExtras.asRunningConfigLines();
    if (rl.length > 0) { lines.push('#'); lines.push(...rl); }
  }

  const bfd = (router as unknown as { getHuaweiBfdService?: () => import('../../router/bfd/HuaweiBfdService').HuaweiBfdService }).getHuaweiBfdService?.();
  if (bfd) {
    const bl = bfd.asRunningConfigLines();
    if (bl.length > 0) { lines.push('#'); lines.push(...bl); }
  }

  const aaaService = (router as unknown as { getHuaweiAaaService?: () => import('../../router/aaa/HuaweiAaaService').HuaweiAaaService }).getHuaweiAaaService?.();
  if (aaaService) {
    const al = aaaService.asRunningConfigLines();
    if (al.length > 0) lines.push(...al);
  }

  appendManagementConfig(lines, router);

  lines.push('#');
  return normaliserBlocsVrp(lines).join('\n');
}

export function displayCounters(router: Router): string {
  const c = router.getCounters();
  return [
    'IP statistics:',
    `  Input:  ${c.ifInOctets} bytes`,
    `  Output: ${c.ifOutOctets} bytes`,
    `  Forward: ${c.ipForwDatagrams} packets`,
    `  Discard: ${c.ipInHdrErrors} header errors, ${c.ipInAddrErrors} no-route`,
    '',
    'ICMP statistics:',
    `  Output: ${c.icmpOutMsgs} packets`,
    `    Destination unreachable: ${c.icmpOutDestUnreachs}`,
    `    Time exceeded: ${c.icmpOutTimeExcds}`,
    `    Echo reply: ${c.icmpOutEchoReps}`,
  ].join('\n');
}

export function displayTrafficFilterApplied(router: Router): string {
  const bindings = router._getInterfaceACLBindingsInternal();
  const rows: string[] = [];
  for (const [ifName, b] of bindings) {
    if (b.inbound !== null) rows.push(` ${ifName.padEnd(33)} inbound    --     ${b.inbound}`);
    if (b.outbound !== null) rows.push(` ${ifName.padEnd(33)} outbound   --     ${b.outbound}`);
  }
  if (rows.length === 0) return 'No traffic-filter applications.';
  return [
    ' Interface                         Direction  AppID  ACL/Policy',
    '--------------------------------------------------------------------------------',
    ...rows,
  ].join('\n');
}

export function displayIpStatistics(router: Router): string {
  const c = router.getCounters();
  return [
    'IP Sent packets statistics:',
    `  Total: ${c.ipForwDatagrams}`,
    `  Local sent out: ${c.ipForwDatagrams}`,
    `  Forwarded: ${c.ipForwDatagrams}`,
    '',
    'IP Received packets statistics:',
    `  Bytes in: ${c.ifInOctets}`,
    `  Bytes out: ${c.ifOutOctets}`,
    `  Header errors: ${c.ipInHdrErrors}`,
    `  Address errors: ${c.ipInAddrErrors}`,
  ].join('\n');
}

export function displayIcmpStatistics(router: Router): string {
  const c = router.getCounters();
  return [
    'ICMP statistics:',
    '  Received:',
    '    echo: 0',
    '    echo reply: 0',
    '    destination unreachable: 0',
    '    time exceeded: 0',
    '  Sent:',
    `    total: ${c.icmpOutMsgs}`,
    `    echo reply: ${c.icmpOutEchoReps}`,
    `    destination unreachable: ${c.icmpOutDestUnreachs}`,
    `    time exceeded: ${c.icmpOutTimeExcds}`,
  ].join('\n');
}

function renderHuaweiIpv6Rows(rt: any[]): string[] {
  const rows: string[] = [];
  for (const r of rt) {
    const prefix = r.prefix ? `${r.prefix}/${r.prefixLength}` : '::/0';
    const proto = r.type === 'connected' ? 'Direct' : r.type === 'default' ? 'Static' : 'Static';
    const pre = r.preference ?? (r.type === 'connected' ? 0 : 60);
    const cost = r.metric ?? 0;
    const flags = r.type === 'connected' ? 'D' : 'RD';
    const nh = r.nextHop ? r.nextHop.toString() : '::';
    rows.push(`Destination  : ${prefix}`);
    rows.push(`NextHop      : ${nh}`);
    rows.push(`Preference   : ${pre}`);
    rows.push(`Cost         : ${cost}`);
    rows.push(`Protocol     : ${proto}`);
    rows.push(`RelayNextHop : ::`);
    rows.push(`TunnelID     : 0x0`);
    rows.push(`Interface    : ${r.iface || '-'}`);
    rows.push(`Flags        : ${flags}`);
    rows.push('');
  }
  return rows;
}

export function displayIpv6RoutingTable(router: Router): string {
  const rt = (router as any)._getIPv6RoutingTableInternal?.() || [];
  const head = [
    'Routing Table : Public',
    `         Destinations : ${rt.length}        Routes : ${rt.length}`,
    '',
  ];
  if (rt.length === 0) {
    return [...head, 'No IPv6 routes configured.'].join('\n');
  }
  return [...head, ...renderHuaweiIpv6Rows(rt)].join('\n').trimEnd();
}

export function displayIpv6RoutingTableProtocol(router: Router, proto: string): string {
  const wanted = proto.toLowerCase();
  const rt = ((router as any)._getIPv6RoutingTableInternal?.() || []).filter((r: any) => {
    if (wanted === 'direct') return r.type === 'connected';
    if (wanted === 'static') return r.type === 'static' || r.type === 'default';
    return false;
  });
  const head = [
    `Public Routing Table : ${proto.toUpperCase()}`,
    `         Destinations : ${rt.length}        Routes : ${rt.length}`,
    '',
  ];
  if (rt.length === 0) return [...head, 'No IPv6 routes configured.'].join('\n');
  return [...head, ...renderHuaweiIpv6Rows(rt)].join('\n').trimEnd();
}

export function displayIpv6Interface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Wrong parameter found at '^' position.`;
  const ipv6Enabled = (port as any).ipv6Enabled === true;
  const addrs = port.getIPv6Addresses?.() || [];
  const isUp = port.getIsUp();
  const isConn = port.isConnected();
  const isVirtual = /^(LoopBack|Tunnel)/i.test(portName);
  const ipv6Mtu = (port as any).ipv6Mtu;
  const raHalt = (port as any).ipv6NdRaHalt === true;
  const lines = [
    `${portName} current state : ${isUp ? (isConn || isVirtual ? 'UP' : 'DOWN') : 'Administratively DOWN'}`,
    `IPv6 protocol current state : ${ipv6Enabled ? 'UP' : 'DOWN'}`,
  ];
  if (addrs.length === 0) lines.push('IPv6 is enabled, link-local address is not assigned');
  for (const a of addrs as IPv6AddressEntry[]) {
    lines.push(`  Global unicast address(es):`);
    lines.push(`    ${a.address}, subnet is ${a.address}/${a.prefixLength}`);
  }
  if (ipv6Mtu) lines.push(`MTU is ${ipv6Mtu} bytes`);
  if (raHalt) lines.push('ND RA messages are suppressed');
  return lines.join('\n');
}

/**
 * Three defects here, all made visible the day `ipv6 enable` started
 * creating a real link-local address (RFC 4862 §5.3) instead of setting
 * a flag: the ZONE INDEX was concatenated with the prefix length
 * (`fe80::1%GE0/0/0/64` — an address that does not exist), several
 * addresses were joined on ONE line so the column overflowed and glued
 * the state onto the address, and a link-local was given a `/64` VRP
 * does not print. One row per address, the zone dropped — the Interface
 * column already names it.
 */
export function displayIpv6InterfaceBrief(router: Router): string {
  const lignes: LigneIpv6Brief[] = [];
  for (const [name, port] of router._getPortsInternal()) {
    const addrs = (port.getIPv6Addresses?.() ?? []) as IPv6AddressEntry[];
    const state = port.isConnected() ? 'up' : 'down';
    if (addrs.length === 0) {
      lignes.push({ iface: name, address: 'unassigned', state });
      continue;
    }
    addrs.forEach((a, i) => lignes.push({
      iface: i === 0 ? name : '',
      address: a.origin === 'link-local'
        ? `${a.address.withScopeId(null)}`
        : `${a.address.withScopeId(null)}/${a.prefixLength}`,
      state: i === 0 ? state : '',
    }));
  }
  return renderTable(lignes, IPV6_BRIEF_COLUMNS, VRP_TABLE).join('\n');
}

interface LigneIpv6Brief { iface: string; address: string; state: string }

const IPV6_BRIEF_COLUMNS: ReadonlyArray<TableColumn<LigneIpv6Brief>> = [
  { header: 'Interface', width: 32, value: (r) => r.iface },
  { header: 'IPv6 Address', width: 30, value: (r) => r.address },
  { header: 'State', value: (r) => r.state },
];

/**
 * `display ipv6 neighbors`. VRP renders one RECORD per neighbour rather
 * than a table, and the fields it shows are not the ones IOS shows: an
 * age in seconds, the router flag learned from the advertisement, and
 * the totals split between dynamic and static entries.
 *
 * `VLAN`/`CEVLAN` are `-` here because a routed port carries neither;
 * `VPN name` is empty and `Secure` FALSE for the same reason the rest of
 * this simulator has no VPN instance or secure-ND model — writing
 * anything else would describe a mechanism that does not run.
 */
/**
 * `display ipv6 statistics` and `display icmpv6 statistics` read the
 * SAME counters as IOS's `show ipv6 traffic` — one data plane, one set
 * of numbers. VRP splits them across two commands where IOS prints one
 * block, so what changes is the layout, never the count.
 */
export function displayIpv6Statistics(router: Router): string {
  const c = router.getIpv6Counters();
  return [
    'IPv6 Protocol:',
    `  Received packets:`,
    `    Total: ${c.inReceives}`,
    `    Local host: ${c.inDelivers}`,
    `    Hoplimit exceeded: ${c.inHopLimitExceeded}`,
    `    No route: ${c.inNoRoutes}`,
    `    Filtered: ${c.inFiltered}`,
    `  Sent packets:`,
    `    Total: ${c.outRequests}`,
    `    Forwarded: ${c.outForwarded}`,
    `    Filtered: ${c.outFiltered}`,
  ].join('\n');
}

export function displayIcmpv6Statistics(router: Router): string {
  const c = router.getIpv6Counters();
  return [
    'ICMPv6 Protocol:',
    '  Received packets:',
    `    Echo request: ${c.icmpInEchoRequests}`,
    `    Echo reply: ${c.icmpInEchoReplies}`,
    `    Neighbor solicit: ${c.ndInSolicits}`,
    `    Neighbor advert: ${c.ndInAdverts}`,
    `    Router solicit: ${c.ndInRouterSolicits}`,
    '  Sent packets:',
    `    Echo reply: ${c.icmpOutEchoReplies}`,
    `    Errors: ${c.icmpOutErrors}`,
    `    Neighbor solicit: ${c.ndOutSolicits}`,
    `    Neighbor advert: ${c.ndOutAdverts}`,
    `    Router advert: ${c.ndOutRouterAdverts}`,
  ].join('\n');
}

export function displayIpv6Neighbors(router: Router, ifFilter?: string): string {
  const rule = '-'.repeat(79);
  const lines: string[] = [rule];
  let total = 0;
  // Same clock the cache stamped the entry with — the scheduler's.
  const nowMs = router.getNeighborCacheNow();
  for (const [ip, entry] of router.getNeighborCache()) {
    if (ifFilter && entry.iface !== ifFilter) continue;
    total++;
    const age = Math.floor(Math.max(0, nowMs - entry.timestamp) / 1000);
    lines.push(`IPv6 Address : ${ip.split('%')[0].toUpperCase()}`);
    lines.push(`Link-layer   : ${huaweiMacAddress(entry.mac).padEnd(22)}State : ${VRP_NEIGHBOR_STATE[entry.state]}`);
    lines.push(`Interface    : ${entry.iface.padEnd(22)}Age   : ${age}`);
    lines.push(`VLAN         : -                     CEVLAN: -`);
    lines.push(`VPN name     :                       Is Router: ${entry.isRouter ? 'TRUE' : 'FALSE'}`);
    lines.push('Secure       : FALSE');
    lines.push(rule);
  }
  lines.push(`Total: ${total}        Dynamic: ${total}     Static: 0`);
  return lines.join('\n');
}

const VRP_NEIGHBOR_STATE: Record<string, string> = {
  incomplete: 'INCMP', reachable: 'REACH', stale: 'STALE',
  delay: 'DELAY', probe: 'PROBE',
};

export function displayDebugging(router: Router): string {
  const debugSvc = (router as unknown as {
    getHuaweiDebugService?: () => HuaweiDebugService;
  }).getHuaweiDebugService?.();
  return debugSvc ? debugSvc.format() : 'No debugging is on';
}

export function displayIpProtocols(router: Router): string {
  if (!router.isRIPEnabled()) return 'No routing protocol is configured.';
  const cfg = router.getRIPConfig();
  const ripRoutes = router.getRIPRoutes();
  const lines = [
    'Routing Protocol is "rip"',
    '  Version: 2',
    `  Update interval: ${cfg.updateInterval / 1000}s`,
    `  Route timeout: ${cfg.routeTimeout / 1000}s`,
    `  Garbage collection: ${cfg.gcTimeout / 1000}s`,
    '',
    '  Networks:',
  ];
  for (const net of cfg.networks) {
    lines.push(`    ${net.network}/${net.mask}`);
  }
  lines.push('');
  lines.push(`  Routes learned: ${ripRoutes.size}`);
  return lines.join('\n');
}

export function displayRip(router: Router): string {
  if (!router.isRIPEnabled()) return 'Info: RIP is not enabled.';
  const cfg = router.getRIPConfig();
  const ripRoutes = router.getRIPRoutes();
  const lines = [
    'RIP process 1',
    '  Version: 2',
    `  Update timer: ${cfg.updateInterval / 1000}s`,
    `  Timeout timer: ${cfg.routeTimeout / 1000}s`,
    `  Garbage-collect timer: ${cfg.gcTimeout / 1000}s`,
    '',
    '  Networks:',
  ];
  for (const net of cfg.networks) {
    lines.push(`    ${net.network}/${net.mask}`);
  }
  lines.push('');
  lines.push(`  Routes: ${ripRoutes.size}`);
  for (const [key, info] of ripRoutes) {
    lines.push(`    ${key} cost ${info.metric} via ${info.learnedFrom} age ${info.age}s${info.garbageCollect ? ' [garbage-collect]' : ''}`);
  }

  return lines.join('\n');
}

function appendManagementConfig(lines: string[], router: Router): void {
  const mgmt = (router as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
  if (!mgmt) return;

  const stelnet = mgmt.getStelnet();
  if (stelnet.enabled) { lines.push('#'); lines.push('stelnet server enable'); }
  const telnet = mgmt.getTelnet();
  if (telnet.enabled) { lines.push('#'); lines.push('telnet server enable'); }
  const ssh = mgmt.getSsh();
  if (ssh.enabled) {
    lines.push('#');
    lines.push('ssh server enable');
    if (ssh.port !== 22) lines.push(`ssh server port ${ssh.port}`);
  }
  if (router.isFtpServerEnabled()) { lines.push('#'); lines.push('ftp server enable'); }
  if (router._getGlobalToggle('telnet server')) { lines.push('#'); lines.push('telnet server enable'); }

  const snmpLines = mgmt.snmpRunningConfigLines();
  if (snmpLines.length > 0) { lines.push('#'); lines.push(...snmpLines); }
  // Lot N2 : ces lignes sortaient d'un sac de chaines brutes, donc elles
  // reproduisaient la saisie sans decrire l'etat — deux lignes pour une
  // adresse configuree deux fois, et un `authentication-mode` ecrit deux
  // fois avec la cle perdue. Elles decrivent l'agent, donc elles se
  // relisent.
  const ntpLignes = lignesConfigNtpVrp(huaweiNtpAgent(router));
  if (ntpLignes.length > 0) {
    lines.push('#');
    lines.push(...ntpLignes);
  }
  const clock = mgmt.getClock();
  if (clock.timezone !== 'UTC' || clock.summerTimezone) {
    lines.push('#');
    if (clock.timezone !== 'UTC') {
      lines.push(`clock timezone ${clock.timezone} ${vrpRenderOffset(clock.offsetMin)}`);
    }
    if (clock.summerTimezone) {
      lines.push(`clock daylight-saving-time ${clock.summerTimezone} repeating ${clock.daylightStart} ${clock.daylightEnd}`);
    }
  }
  // La configuration est REJOUÉE à l'import : elle rend maintenant ce
  // qui a été tapé, transport, port, précision d'horodatage et type
  // d'enregistrement compris. Ce qui vaut l'usine n'est pas rendu.
  const infoLines = mgmt.getInfoCenter().toRunningConfig();
  if (infoLines.length > 0) {
    lines.push('#');
    lines.push(...infoLines);
  }
  const sflow = mgmt.getSflow();
  if (sflow.enabled) {
    lines.push('#');
    if (sflow.agentIp) lines.push(`sflow agent ip ${sflow.agentIp}`);
    for (const c of sflow.collectors) lines.push(`sflow collector ${c.id} ip ${c.ip} port ${c.port}`);
    for (const s of sflow.samplers) lines.push(`sflow sampling rate ${s.rate}`);
  }
  const routingLimit = (router as unknown as { getRoutingTableLimit?: () => { max: number; thresholdPct?: number } | null }).getRoutingTableLimit?.();
  if (routingLimit) {
    lines.push('#');
    lines.push(`ip routing-table limit ${routingLimit.max}${routingLimit.thresholdPct !== undefined ? ' ' + routingLimit.thresholdPct : ''}`);
  }
  const nqa = nqaRunningConfigLines(router);
  if (nqa.length > 0) {
    lines.push('#');
    lines.push(...nqa);
  }
}

export function displayCurrentConfigInterface(router: Router, ifName: string): string {
  const portName = resolveHuaweiInterfaceName(router, ifName) || ifName;
  const port = router.getPort(portName);
  if (!port) return `Error: Interface "${ifName}" does not exist.`;

  const ip = port.getIPAddress();
  const mask = port.getSubnetMask();
  const desc = router.getInterfaceDescription(portName);
  const lines = [
    '#',
    // Le nom canonique, comme la configuration complete le rend deja :
    // cette vue-ci ecrivait `interface GE0/0/0`, le nom court interne,
    // dans un bloc de CONFIGURATION (lots V3/V11, puis V15).
    `interface ${huaweiDisplayInterfaceName(portName)}`,
  ];
  if (desc) lines.push(` description ${desc}`);
  if (port.isDhcpClient()) {
    lines.push(' ip address dhcp-alloc');
  } else if (ip && mask) {
    lines.push(` ip address ${ip} ${mask}`);
  } else {
    lines.push(` shutdown`);
  }

  lines.push(...renderHuaweiInterfaceExtras(router, port, portName));

  lines.push('#');
  return lines.join('\n');
}

/**
 * Ce que les deux rendus de configuration ajoutent apres l'adresse.
 *
 * Les lignes `vrrp` y entrent au lot V15 parce que les deux chemins qui
 * rendaient une configuration se contredisaient : le complet n'en
 * rendait AUCUNE, celui par interface les rendait toutes. Les mettre ici
 * est ce qui rend le desaccord impossible plutot que rattrape.
 */
const JOURS_VERS_VRP: Record<string, string> = {
  daily: 'daily', weekdays: 'working-day', weekend: 'off-day',
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
};

export function vrpTimeRangeLines(router: Router): string[] {
  const sec = (router as unknown as {
    [s: symbol]: { timeRanges?: Map<string, {
      name: string;
      periodic: Array<{ days: string; startHour: number; startMinute: number; endHour: number; endMinute: number }>;
    }> } | undefined;
  })[Symbol.for('CiscoSecurityConfig')];
  const deuxChiffres = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  const out: string[] = [];
  for (const tr of sec?.timeRanges?.values() ?? []) {
    for (const p of tr.periodic) {
      const jours = p.days.split(' ').map((j) => JOURS_VERS_VRP[j] ?? j).join(' ');
      out.push(`time-range ${tr.name} ${deuxChiffres(p.startHour)}:${deuxChiffres(p.startMinute)}`
        + ` to ${deuxChiffres(p.endHour)}:${deuxChiffres(p.endMinute)} ${jours}`);
    }
  }
  return out;
}

export function vrpNatInterfaceLines(router: Router, portName: string): string[] {
  const engine = (router as any)._getNATEngine?.();
  if (!engine) return [];
  const lines: string[] = [];
  for (const rule of engine.getDynamicRules() as Array<{
    aclId: string | number; type: string; poolName?: string;
    interfaceName?: string; noPat?: boolean;
  }>) {
    if (rule.interfaceName !== portName) continue;
    const groupe = rule.type === 'pool' && rule.poolName ? ` address-group ${rule.poolName}` : '';
    lines.push(` nat outbound ${rule.aclId}${groupe}${rule.noPat ? ' no-pat' : ''}`);
  }
  if (!engine.getOutsideInterfaces().has(portName)) return lines;
  for (const e of engine.getStaticEntries() as Array<{
    localIP: string; globalIP: string; protocol?: string;
    localPort?: number; globalPort?: number;
  }>) {
    if (!e.protocol || e.globalPort === undefined || e.localPort === undefined) continue;
    lines.push(` nat server protocol ${e.protocol} global ${e.globalIP} ${e.globalPort}`
      + ` inside ${e.localIP} ${e.localPort}`);
  }
  return lines;
}

export function vrpNatGlobalLines(router: Router): string[] {
  const engine = (router as any)._getNATEngine?.();
  if (!engine) return [];
  const lines: string[] = [];
  for (const [, pool] of engine.getPools() as Map<string, { name: string; startIP: string; endIP: string }>) {
    lines.push(`nat address-group ${pool.name} ${pool.startIP} ${pool.endIP}`);
  }
  return lines;
}

const VRP_OSPF_IF_DEFAULTS: Record<string, unknown> = {
  priority: 1, helloInterval: 10, deadInterval: 40,
  networkType: 'broadcast', authType: 0,
};

export function vrpOspfInterfaceLines(pending: Record<string, unknown> | undefined): string[] {
  if (!pending) return [];
  const lines: string[] = [];
  const ecart = (cle: string) =>
    pending[cle] !== undefined && pending[cle] !== VRP_OSPF_IF_DEFAULTS[cle];

  if (pending.cost !== undefined) lines.push(` ospf cost ${pending.cost}`);
  if (ecart('priority')) lines.push(` ospf dr-priority ${pending.priority}`);
  if (ecart('helloInterval')) lines.push(` ospf timer hello ${pending.helloInterval}`);
  if (ecart('deadInterval')) lines.push(` ospf timer dead ${pending.deadInterval}`);
  if (ecart('networkType')) lines.push(` ospf network-type ${pending.networkType}`);
  if (pending.authType === 1) {
    lines.push(` ospf authentication-mode simple${pending.authKey ? ` cipher ${pending.authKey}` : ''}`);
  }
  if (pending.authType === 2) {
    const keyId = pending.authKeyId ?? 1;
    lines.push(` ospf authentication-mode md5 ${keyId}${pending.authKey ? ` cipher ${pending.authKey}` : ''}`);
  }
  if (pending.silent) lines.push(' ospf silent-interface');
  return lines;
}

export function vrpRipInterfaceLines(port: {
  getRipSendVersion?: () => string | null;
  getRipReceiveVersion?: () => string | null;
  getRipAuthMode?: () => string | null;
  getRipAuthKeyChain?: () => string | null;
  isRipV2Broadcast?: () => boolean;
  getRipSummaries?: () => readonly string[];
}): string[] {
  const lines: string[] = [];
  const version = port.getRipSendVersion?.() ?? port.getRipReceiveVersion?.() ?? null;
  if (version) {
    const diffusion = port.isRipV2Broadcast?.() ? ' broadcast' : version === '2' ? ' multicast' : '';
    lines.push(` rip version ${version}${diffusion}`);
  }
  const mode = port.getRipAuthMode?.();
  if (mode) {
    const cle = port.getRipAuthKeyChain?.();
    lines.push(` rip authentication-mode ${mode}${cle ? ` cipher ${cle}` : ''}`);
  }
  for (const l of port.getRipSummaries?.() ?? []) lines.push(` ${l}`);
  return lines;
}

export function renderHuaweiInterfaceExtras(router: Router, port: any, portName: string): string[] {
  const lines: string[] = [];
  lines.push(...lignesConfigVrrp(huaweiVrrpAgent(router)?.listGroups() ?? [], portName));
  const extra = router._getOSPFExtraConfig();
  const pending = extra.pendingIfConfig?.get(portName) as any;
  lines.push(...vrpOspfInterfaceLines(pending));
  lines.push(...vrpRipInterfaceLines(port));
  if (port.isNegotiationAuto?.() === false) {
    const vitesse = port.getSpeed?.();
    if (vitesse) lines.push(` speed ${vitesse}`);
    const duplex = port.getDuplex?.();
    if (duplex) lines.push(` duplex ${duplex}`);
  }
  if (pending?.tunnelProtocol) lines.push(` tunnel-protocol ${pending.tunnelProtocol}`);
  if (pending?.tunnelSource) lines.push(` source ${pending.tunnelSource}`);
  if (pending?.tunnelDest) lines.push(` destination ${pending.tunnelDest}`);
  if (pending?.greKey !== undefined) lines.push(` gre key ${pending.greKey}`);
  if (pending?.ipsecProfile) lines.push(` ipsec profile ${pending.ipsecProfile}`);
  if (pending?.tunnelKeepalivePeriod !== undefined) {
    const kp = pending.tunnelKeepalivePeriod;
    const kr = pending.tunnelKeepaliveRetry;
    lines.push(` keepalive period ${kp}${kr !== undefined ? ` retry-times ${kr}` : ''}`);
  }
  const dhcp = router._getDHCPServerInternal();
  const dhcpMode = dhcp.getInterfaceMode(portName);
  if (dhcpMode === 'global' || dhcpMode === 'relay' || dhcpMode === 'interface') {
    lines.push(` dhcp select ${dhcpMode}`);
  }
  if (dhcpMode === 'interface') {
    const dns = dhcp.getPool(interfacePoolName(portName))?.dnsServers ?? [];
    if (dns.length > 0) lines.push(` dhcp server dns-list ${dns.join(' ')}`);
  }
  for (const h of dhcp.getHelperAddresses(portName)) lines.push(` dhcp relay server-ip ${h}`);
  if (dhcp.isSnoopingEnabled(portName)) lines.push(' dhcp snooping enable');
  const ipsecEngine = (router as any)._getIPSecEngineInternal?.();
  if (ipsecEngine) {
    const ifCrypto = ipsecEngine.ifaceCryptoMap?.get(portName);
    if (ifCrypto) lines.push(` ipsec policy ${ifCrypto}`);
    const tp = ipsecEngine.tunnelProtection?.get(portName);
    if (tp) lines.push(` ipsec profile ${tp.profileName}`);
  }
  for (const regle of router.getCarPolicer(portName)?.list() ?? []) {
    lines.push(` ${regle.raw.trim()}`);
  }
  lines.push(...runningConfigInterfaceACL(router, portName));
  lines.push(...vrpNatInterfaceLines(router, portName));
  for (const app of router.getTrafficPolicyStore().listApplications()) {
    if (app.iface !== portName) continue;
    lines.push(` traffic-policy ${app.policy} ${app.direction}`);
  }
  if (port.dot1qVlan !== undefined) lines.push(` dot1q termination vid ${port.dot1qVlan}`);
  if (port.arpBroadcastEnabled) lines.push(` arp broadcast enable`);
  if (typeof port.isProxyArpExplicit === 'function' && port.isProxyArpExplicit() && port.isProxyArpEnabled?.()) {
    lines.push(` arp-proxy enable`);
  }
  if (port.arpTimeoutSec !== undefined && port.arpTimeoutSec !== 4 * 60 * 60 && typeof port.getArpTimeoutSec === 'function') {
    lines.push(` arp expire-time ${port.getArpTimeoutSec()}`);
  }
  if (typeof port.getMTU === 'function' && port.getMTU() !== 1500) lines.push(` mtu ${port.getMTU()}`);
  if (typeof port.getBandwidthKbps === 'function' && port.getBandwidthKbps() > 0) lines.push(` bandwidth ${port.getBandwidthKbps()}`);
  if (port.configuredMacAddress) lines.push(` mac-address ${port.configuredMacAddress}`);
  if (port.loopbackInternal) lines.push(` loopback internal`);
  if (port.flowControl) lines.push(` flow-control`);
  if (port.ipv6Enabled) lines.push(` ipv6 enable`);
  for (const entry of port.getIPv6Addresses?.() ?? []) {
    if (entry.origin !== 'static') continue;
    lines.push(` ipv6 address ${entry.address}/${entry.prefixLength}`);
  }
  const v3 = (router as any)._getOSPFv3EngineInternal?.();
  const v3Iface = v3?.getInterface?.(portName);
  if (v3Iface) lines.push(` ospfv3 ${v3.getProcessId?.() ?? 1} area ${v3Iface.areaId}`);
  if (port.ipv6Mtu) lines.push(` ipv6 mtu ${port.ipv6Mtu}`);
  if (port.ipv6NdRaHalt) lines.push(` ipv6 nd ra halt`);
  return lines;
}

// ─── Trie Registration ──────────────────────────────────────────────

function huaweiNtpAgent(router: Router): import('../../../ntp/NtpAgent').NtpAgent | undefined {
  return (router as unknown as { getNtpAgent?: () => import('../../../ntp/NtpAgent').NtpAgent }).getNtpAgent?.();
}

function huaweiVrrpAgent(router: Router): import('../../../vrrp/VrrpAgent').VrrpAgent | undefined {
  return (router as unknown as { getVrrpAgent?: () => import('../../../vrrp/VrrpAgent').VrrpAgent }).getVrrpAgent?.();
}

/**
 * Register all "display" commands on a CommandTrie.
 * Used by HuaweiVRPShell to wire display commands onto per-mode tries.
 */
export function registerDisplayCommands(
  trie: CommandTrie,
  getRouter: () => Router,
  getState: () => HuaweiDisplayState,
): void {
  trie.register('display version', 'Display version information', () => displayVersion(getRouter()));
  trie.registerGreedy('display ip routing-table', 'Display IP routing table', (args) => {
    if (args.length === 0) return displayIpRoutingTable(getRouter());
    if (/^\d+\.\d+\.\d+\.\d+$/.test(args[0])) return displayIpRoutingTableForDest(getRouter(), args[0]);
    return displayIpRoutingTable(getRouter());
  });
  trie.register('display ip traffic', 'Display IP traffic statistics', () => displayCounters(getRouter()));
  trie.register('display ip statistics', 'Display IP statistics', () => displayIpStatistics(getRouter()));
  trie.register('display icmp statistics', 'Display ICMP statistics', () => displayIcmpStatistics(getRouter()));
  trie.register('display arp', 'Display ARP table', () => displayArp(getRouter()));
  trie.register('display arp all', 'Display all ARP entries', () => displayArp(getRouter()));
  trie.register('display arp static', 'Display static ARP entries', () => displayArpFiltered(getRouter(), 'static'));
  trie.register('display arp dynamic', 'Display dynamic ARP entries', () => displayArpFiltered(getRouter(), 'dynamic'));
  trie.register('display arp statistics', 'Display ARP statistics', () => displayArpStatistics(getRouter()));
  trie.register('display arp statistics all', 'Display all ARP statistics', () => displayArpStatistics(getRouter()));
  trie.registerGreedy('display arp interface', 'Display ARP entries on an interface', (args) =>
    displayArpInterface(getRouter(), args.join(' ')));
  trie.register('display current-configuration', 'Display running configuration', () => {
    const s = getState();
    return displayCurrentConfig(getRouter(), s.isDhcpEnabled(), s.isDhcpSnoopingEnabled());
  });

  trie.registerGreedy('display current-configuration configuration', 'Display module configuration', (args) => {
    const s = getState();
    const full = displayCurrentConfig(getRouter(), s.isDhcpEnabled(), s.isDhcpSnoopingEnabled());
    const module = (args[0] ?? '').toLowerCase();
    if (!module) return full;
    const keywords = module === 'dhcp' ? ['dhcp', 'ip pool'] : [module];
    const match = (s: string) => keywords.some(k => s.toLowerCase().includes(k));
    const lines = full.split('\n');
    const kept: string[] = [];
    let inBlock = false;
    for (const line of lines) {
      const top = line.length > 0 && line[0] !== ' ' && line[0] !== '#';
      if (top) inBlock = match(line);
      if (inBlock || (!top && match(line))) kept.push(line);
    }
    return kept.length ? kept.join('\n') : '';
  });

  trie.register('display traffic-filter applied-record', 'Display traffic-filter applications', () =>
    displayTrafficFilterApplied(getRouter()));

  trie.register('display saved-configuration', 'Display saved configuration', () => {
    // Real semantics: render the snapshot captured by `save` — NOT a
    // mirror of the running configuration. An unsaved device has no
    // configuration file, exactly like real VRP.
    const snapshot = (getRouter() as unknown as { getStartupConfigSnapshot?: () => string | null })
      .getStartupConfigSnapshot?.();
    if (!snapshot) return "Error: The configuration file doesn't exist.";
    return snapshot;
  });

  trie.register('display startup', 'Display startup configuration', () => {
    return [
      'MainBoard:',
      `  Configured startup system software:    flash:/vrp.cc`,
      `  Startup system software:                flash:/vrp.cc`,
      `  Next startup system software:           flash:/vrp.cc`,
      `  Startup saved-configuration file:       flash:/vrpcfg.zip`,
      `  Next startup saved-configuration file:  flash:/vrpcfg.zip`,
      `  Startup license file:                   NULL`,
      `  Next startup license file:              NULL`,
      `  Startup patch package:                  NULL`,
      `  Next startup patch package:             NULL`,
    ].join('\n');
  });

  trie.registerGreedy('display history-command', 'Display CLI history', () => {
    const dev = getRouter() as unknown as { getShell?: () => { getCmdHistory?: () => readonly string[] } };
    const shell = dev.getShell?.();
    const history = shell?.getCmdHistory?.() ?? [];
    if (history.length === 0) return 'Info: No history command.';
    return history.join('\n');
  });

  trie.registerGreedy('display alarm', 'Display alarm records', () =>
    commonDisplayAlarm());

  trie.register('display aaa configuration', 'Display AAA configuration', () => {
    const aaa = (getRouter() as unknown as { getShell?: () => { getAaaExtraConfig?: () => { authenticationSchemes: string[]; authorizationSchemes: string[]; accountingSchemes: string[]; domains: string[] } | null } }).getShell?.();
    const cfg = aaa?.getAaaExtraConfig?.();
    if (!cfg) {
      return [
        '  Domain Name           : default',
        '  Domain State          : Active',
        '  Authentication-scheme : default',
        '  Authorization-scheme  : default',
        '  Accounting-scheme     : default',
        '  Service-scheme        : -',
        '  RADIUS-server-template: -',
        '  HWTACACS-server-template: -',
      ].join('\n');
    }
    const lines: string[] = [];
    const domains = cfg.domains.length > 0 ? cfg.domains : ['default'];
    for (const d of domains) {
      lines.push(`  Domain Name           : ${d}`);
      lines.push('  Domain State          : Active');
      lines.push(`  Authentication-scheme : ${cfg.authenticationSchemes[0] ?? 'default'}`);
      lines.push(`  Authorization-scheme  : ${cfg.authorizationSchemes[0] ?? 'default'}`);
      lines.push(`  Accounting-scheme     : ${cfg.accountingSchemes[0] ?? 'default'}`);
      lines.push('  Service-scheme        : -');
      lines.push('  RADIUS-server-template: -');
      lines.push('  HWTACACS-server-template: -');
    }
    return lines.join('\n');
  });

  trie.register('display aaa online-fail-record', 'Display AAA failed login attempts', () => {
    return 'Info: No online-fail record.';
  });

  trie.register('display user-interface', 'Display user interface info', () => {
    const store = getVtyLineConfig(getRouter());
    const lines = [renderDisplayUserInterface(getSessionRegistry(getRouter()), store)];
    const cfg = store ? store.renderAllHuawei() : [];
    if (cfg.length > 0) { lines.push(''); lines.push(...cfg); }
    return lines.join('\n');
  });

  trie.register('display dhcp snooping configuration', 'Display DHCP snooping configuration', () => {
    const sw = getSwitchSecurityService(getRouter());
    if (!sw) return 'Info: DHCP snooping is not configured';
    const enabled = sw.isDhcpSnoopingEnabled();
    const vlans = sw.getDhcpSnoopingVlans();
    const trust = sw.getDhcpSnoopingTrust();
    const lines = [
      `DHCP snooping global status : ${enabled ? 'enabled' : 'disabled'}`,
      `DHCP snooping enabled VLANs : ${vlans.length === 0 ? 'none' : vlans.join(',')}`,
    ];
    if (trust.length > 0) {
      lines.push('Trusted interfaces:');
      for (const t of trust) lines.push(`  ${t.ifName}`);
    }
    return lines.join('\n');
  });

  trie.register('display arp anti-attack configuration', 'Display ARP anti-attack configuration', () => {
    const sw = getSwitchSecurityService(getRouter());
    if (!sw) return 'Info: ARP anti-attack is not configured';
    const policies = sw.getArpAntiAttackPolicies();
    if (policies.length === 0) return 'Info: ARP anti-attack is not configured';
    return policies.map(p =>
      `ARP anti-attack: validateSource=${!!p.validateSource}, rateLimit=${p.rateLimit ?? 'none'}, detectionMode=${p.detectionMode ?? 'none'}`
    ).join('\n');
  });

  trie.register('display ip source check user-bind configuration', 'Display IP source guard configuration', () => {
    const sw = getSwitchSecurityService(getRouter());
    if (!sw) return 'Info: IP source guard is not configured';
    const enabled = sw.isIpSourceGuardEnabled();
    const bindings = sw.getIpSourceGuardBindings();
    const lines = [`IP source guard global status: ${enabled ? 'enabled' : 'disabled'}`];
    if (bindings.length === 0) {
      lines.push('Info: No static user bindings configured');
    } else {
      lines.push('Static bindings:');
      for (const b of bindings) {
        lines.push(`  ip=${b.ipAddress ?? '-'} mac=${b.macAddress ?? '-'} interface=${b.ifName ?? '-'} vlan=${b.vlan ?? '-'} type=${b.type}`);
      }
    }
    return lines.join('\n');
  });
  // `source` et `check` ne sont créés qu'en CHEMIN par la ligne
  // ci-dessus : ils naissaient donc avec leur propre mot pour
  // description, que le rendu blanchit — `display ip ?` répondait
  // « source  Source », qui n'apprend rien.
  trie.describeNode('display ip source', 'IP source guard information');
  trie.describeNode('display ip source check', 'IP source check information');

  trie.register('display dhcp server statistics', 'Display DHCP server statistics', () => {
    const dhcp = getRouter()._getDHCPServerInternal();
    const poolCount = [...dhcp.getAllPools().keys()].filter(n => !isInterfacePoolName(n)).length;
    const s = (dhcp as unknown as { getStats?: () => { discovers: number; offers: number; requests: number; acks: number; naks: number; releases: number; informs: number; declines: number } }).getStats?.() ?? {
      discovers: 0, offers: 0, requests: 0, acks: 0, naks: 0, releases: 0, informs: 0, declines: 0,
    };
    const total = s.discovers + s.requests + s.releases + s.informs + s.declines;
    const sent = s.offers + s.acks + s.naks;
    return [
      'DHCP server packets statistics:',
      `  Receive total: ${total}`,
      `  Send total: ${sent}`,
      `  Discover: ${s.discovers}      Offer: ${s.offers}`,
      `  Request: ${s.requests}       Ack: ${s.acks}`,
      `  Nak: ${s.naks}           Release: ${s.releases}`,
      `  Inform: ${s.informs}        Decline: ${s.declines}`,
      `Pool number: ${poolCount}`,
    ].join('\n');
  });

  trie.register('display nat session all', 'Display NAT session table', () => {
    const nat = (getRouter() as unknown as { _getNATEngine?: () => { getSessions?: () => readonly { localIP: string; localPort: number; outsideGlobal?: string; outsideGlobalPort?: number; protocol: number }[] } })._getNATEngine?.();
    const sessions = nat?.getSessions?.() ?? [];
    if (sessions.length === 0) return 'Info: No NAT session is found.';
    const lines = ['Protocol  Local                         Global                        Outside'];
    for (const s of sessions) {
      lines.push(`${String(s.protocol).padEnd(10)}${(s.localIP + ':' + s.localPort).padEnd(30)}${(s.outsideGlobal ?? '-') + ':' + (s.outsideGlobalPort ?? 0)}`);
    }
    return lines.join('\n');
  });

  trie.register('display nat address-group', 'Display NAT address groups', () => {
    const nat = (getRouter() as unknown as { _getNATEngine?: () => { getPools?: () => Map<string, { name: string; startIP: string; endIP: string }> } })._getNATEngine?.();
    const pools = nat?.getPools?.();
    if (!pools || pools.size === 0) return 'Info: No NAT address-group is configured.';
    return [...pools.values()].map(p => `${p.name}: ${p.startIP} - ${p.endIP}`).join('\n');
  });

  // Lot V15 : ces vues lisaient la facade `HuaweiVrrpService` — un
  // second magasin — et rendaient donc une priorite que le `track`
  // n'avait jamais fait bouger, sous le nom court interne de
  // l'interface. Elles lisent l'agent, par le rendu partage avec le
  // commutateur.
  trie.register('display vrrp', 'Display VRRP groups', () =>
    rendreDisplayVrrp(huaweiVrrpAgent(getRouter())?.listGroups() ?? []));
  trie.registerGreedy('display vrrp interface', 'Display VRRP on interface', (args) => {
    const demande = args.join(' ');
    const ifName = resolveHuaweiInterfaceName(getRouter(), demande);
    if (!ifName) return HUAWEI_ERRORS.WRONG(`display vrrp interface ${demande}`, 'display vrrp interface '.length);
    const groups = groupesDeLInterface(huaweiVrrpAgent(getRouter()), ifName);
    if (groups.length === 0) return AUCUN_GROUPE;
    return rendreDisplayVrrp(groups);
  });
  trie.register('display vrrp statistics', 'Display VRRP statistics', () => {
    const ag = huaweiVrrpAgent(getRouter());
    return rendreDisplayVrrpStatistics(ag?.listGroups() ?? [], ag?.getGlobalStats());
  });
  // `reset vrrp statistics` : une commande qui promet de remettre a zero
  // doit le faire. Elle etait absente, donc un operateur ne pouvait pas
  // repartir d'un comptage propre avant une mesure.
  trie.register('reset vrrp statistics', 'Clear VRRP statistics', () => {
    huaweiVrrpAgent(getRouter())?.resetStats();
    return '';
  });

  trie.register('display bfd configuration all', 'Display BFD configuration', () => {
    const svc = (getRouter() as unknown as { getHuaweiBfdService?: () => import('../../router/bfd/HuaweiBfdService').HuaweiBfdService }).getHuaweiBfdService?.();
    if (!svc || !svc.isEnabled()) return 'Info: BFD is not enabled';
    const sessions = svc.list();
    if (sessions.length === 0) return 'Info: No BFD sessions configured';
    return sessions.map(s => [
      `Session: ${s.name}`,
      `  Peer IP: ${s.peerIp ?? '<not set>'}`,
      `  Source IP: ${s.sourceIp ?? '<not set>'}`,
      s.outIface ? `  Interface: ${s.outIface}` : '',
      `  Local discriminator: ${s.discriminatorLocal ?? 'auto'}`,
      `  Remote discriminator: ${s.discriminatorRemote ?? 'auto'}`,
      `  Min Tx interval: ${s.minTxIntervalMs ?? 'default'}ms`,
      `  Min Rx interval: ${s.minRxIntervalMs ?? 'default'}ms`,
      `  Detect multiplier: ${s.detectMultiplier ?? 3}`,
    ].filter(Boolean).join('\n')).join('\n\n');
  });
  trie.register('display bfd session all', 'Display BFD sessions', () => {
    const svc = (getRouter() as unknown as { getHuaweiBfdService?: () => import('../../router/bfd/HuaweiBfdService').HuaweiBfdService }).getHuaweiBfdService?.();
    if (!svc) return 'Info: BFD is not enabled';
    const sessions = svc.list();
    if (sessions.length === 0) return 'Info: No BFD sessions';
    const lines = ['Local Remote      PeerIpAddr       State     Type        InterfaceName'];
    for (const s of sessions) {
      lines.push(`${String(s.discriminatorLocal ?? '-').padEnd(6)}${String(s.discriminatorRemote ?? '-').padEnd(12)}${(s.peerIp ?? '-').padEnd(17)}${s.state.padEnd(10)}${(s.auto ? 'AUTO' : 'STATIC').padEnd(12)}${s.outIface ?? '-'}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display qos car interface', 'Display QoS CAR', () => 'Info: No QoS CAR configured');
  trie.registerGreedy('display qos configuration interface', 'Display QoS configuration', () => 'Info: No QoS policy configured');
  trie.registerGreedy('display qos cq interface', 'Display custom queue', () => 'Info: Custom queueing not configured');
  trie.registerGreedy('display qos pq interface', 'Display priority queue', () => 'Info: Priority queueing not configured');
  trie.registerGreedy('display qos queue statistics interface', 'Display QoS queue stats', () => 'Info: No QoS statistics');
  trie.register('display qos map-table', 'Display QoS map tables', () => 'Info: No QoS map tables');
  trie.registerGreedy('display traffic classifier', 'Display traffic classifiers', () => 'Info: No traffic classifiers configured');
  trie.registerGreedy('display traffic behavior', 'Display traffic behaviors', () => 'Info: No traffic behaviors configured');
  trie.registerGreedy('display traffic policy', 'Display traffic policies', () => 'Info: No traffic policies configured');

  trie.register('display vrrp brief', 'Display VRRP brief', () =>
    rendreDisplayVrrpBrief(huaweiVrrpAgent(getRouter())?.listGroups() ?? []));

  trie.register('display ssh server status', 'Display SSH server status', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const ssh = mgmt?.getSsh();
    if (!ssh || !ssh.enabled) return 'SSH server: Disabled';
    return [
      `SSH version: ${ssh.version}`,
      `SSH authentication retries: ${ssh.retries}`,
      `SSH server timeout (sec): ${ssh.timeout}`,
      `SSH server port: ${ssh.port}`,
    ].join('\n');
  });

  trie.register('display stelnet server', 'Display STelnet server status', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const st = mgmt?.getStelnet();
    if (!st || !st.enabled) return 'STelnet server: Disabled';
    return `STelnet server: Enabled\nSTelnet server port: ${st.port}`;
  });

  trie.register('display telnet server status', 'Display Telnet server status', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const tn = mgmt?.getTelnet();
    if (!tn || !tn.enabled) return 'Telnet server: Disabled';
    return `Telnet server: Enabled\nTelnet server port: ${tn.port}`;
  });

  trie.register('display snmp-agent local-engineid', 'Display SNMP engine ID', () => {
    const snmp = (getRouter() as unknown as { getSnmpService?: () => import('../../router/management/SnmpService').SnmpService }).getSnmpService?.();
    return snmp ? `SNMP local EngineID: ${snmp.getEngineId()}` : 'SNMP is not enabled';
  });

  trie.register('display snmp-agent sys-info', 'Display SNMP system info', () => {
    const snmp = (getRouter() as unknown as { getSnmpService?: () => import('../../router/management/SnmpService').SnmpService }).getSnmpService?.();
    if (!snmp) return 'SNMP is not enabled';
    return [
      `Contact: ${snmp.getContact() || '<not set>'}`,
      `Location: ${snmp.getLocation() || '<not set>'}`,
      `Chassis-id: ${snmp.getChassisId() || '<not set>'}`,
    ].join('\n');
  });

  // Lot N2 : ces deux vues lisaient l'agent, ce qui etait juste — mais
  // le CLI ecrivait ailleurs, si bien que `sessions` repondait
  // `No NTP associations` sur une machine dont la configuration listait
  // quatre serveurs. Le rendu est partage et le magasin unique.
  trie.register('display ntp-service status', 'Display NTP service status',
    () => displayNtpServiceStatus(huaweiNtpAgent(getRouter())));
  trie.register('reset ntp-service statistics packet', 'Clear NTP packet statistics',
    () => { huaweiNtpAgent(getRouter())?.clearCounters(); return ''; });
  trie.register('display ntp-service statistics packet', 'NTP packet statistics',
    () => displayNtpStatisticsPacket(huaweiNtpAgent(getRouter())));
  trie.register('display ntp-service sessions verbose', 'Detailed NTP sessions',
    () => displayNtpServiceSessions(huaweiNtpAgent(getRouter()), true));
  trie.register('display ntp-service sessions', 'Display NTP sessions',
    () => displayNtpServiceSessions(huaweiNtpAgent(getRouter())));

  trie.register('display info-center', 'Display info-center configuration', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const ic = mgmt?.getInfoCenter();
    if (!ic) return 'Info-center: Disabled';
    const t = ic.timestamps;
    return [
      `Info-center: ${ic.enabled ? 'Enabled' : 'Disabled'}`,
      `Log host: ${ic.loghosts.length ? ic.loghosts.map(h => h.ip).join(', ') : '(none)'}`,
      `Log host source interface: ${ic.loghostSource ?? '(none)'}`,
      `Log buffer size: ${ic.logbufferSize}`,
      `Trap buffer size: ${ic.trapbufferSize}`,
      `Timestamp: log ${t.log.format}, trap ${t.trap.format}, debug ${t.debug.format}`,
      `Configured sources: ${ic.sources.length}`,
      `Configured loghosts: ${ic.loghosts.length}`,
    ].join('\n');
  });

  trie.register('display sflow', 'Display sFlow configuration', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const sf = mgmt?.getSflow();
    if (!sf || !sf.enabled) return 'sFlow: Disabled';
    return [
      `sFlow: Enabled`,
      `Agent IP: ${sf.agentIp || '<not set>'}`,
      `Collectors: ${sf.collectors.length}`,
      `Samplers: ${sf.samplers.length}`,
    ].join('\n');
  });

  trie.register('display lldp neighbor', 'Display LLDP neighbors', () => {
    const agent = (getRouter() as unknown as { getLldpAgent?: () => { getNeighbors: () => readonly { localPort: string; chassisId: string; portId: string; systemName: string; portDescription: string; expiresAtMs: number }[] } }).getLldpAgent?.();
    const neighbors = agent?.getNeighbors() ?? [];
    if (neighbors.length === 0) return 'Info: No LLDP neighbor is found.';
    return neighbors.map(n => [
      `Local Intf: ${n.localPort}`,
      `Chassis id: ${n.chassisId}`,
      `Port id: ${n.portId}`,
      `Port description: ${n.portDescription}`,
      `System name: ${n.systemName}`,
      `Time remaining: ${Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000))} seconds`,
    ].join('\n')).join('\n\n');
  });

  trie.register('display lldp neighbor brief', 'Display LLDP brief', () => {
    const agent = (getRouter() as unknown as { getLldpAgent?: () => { getNeighbors: () => readonly { localPort: string; systemName: string; portId: string; expiresAtMs: number }[] } }).getLldpAgent?.();
    const neighbors = agent?.getNeighbors() ?? [];
    const lines = ['Local Intf    Neighbor Dev    Neighbor Intf    Exptime(s)'];
    for (const n of neighbors) {
      const exp = Math.max(0, Math.floor((n.expiresAtMs - Date.now()) / 1000));
      lines.push(`${n.localPort.padEnd(14)}${n.systemName.padEnd(16)}${n.portId.padEnd(17)}${exp}`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display bgp peer', 'Display BGP peers', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    const bgp = ex?.getBgp();
    if (!bgp) return 'Info: BGP is not running.';
    // Peering/session state comes from the real BGPEngine (same engine
    // Cisco routers use) — the facade above only supplies configured
    // metadata (router-id, peer list) it doesn't model. Audit 02:
    // `display bgp peer` used to fabricate "Idle"/0 regardless of the
    // real session state.
    const e = getRouter().getBGPEngine();
    getRouter().convergeDynamicRouting();
    const byId = new Map(e.getNeighbors().map((n) => [n.id, n]));
    const established = [...byId.values()].filter((n) => n.state === 'Established').length;
    const lines = [
      `BGP local router ID : ${bgp.routerId ?? '0.0.0.0'}`,
      `Local AS number : ${bgp.asn}`,
      `Total number of peers : ${bgp.peers.size}              Peers in established state : ${established}`,
      '  Peer            V          AS  MsgRcvd  MsgSent  OutQ  Up/Down       State PrefRcv',
    ];
    for (const [ip, p] of bgp.peers) {
      const v = byId.get(ip);
      const upDown = v && v.isUp ? `${v.uptimeSec}s` : '00:00:00';
      const state = v ? v.state : 'Idle';
      lines.push(`  ${ip.padEnd(15)}  4    ${String(p.asNumber ?? bgp.asn).padEnd(5)}     0        0     0  ${upDown.padEnd(8)}      ${state}       0`);
    }
    return lines.join('\n');
  });

  trie.registerGreedy('display bgp routing-table', 'Display BGP routing table', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    const bgp = ex?.getBgp();
    if (!bgp) return 'Info: BGP is not running.';
    // Real Loc-RIB (learned + originated routes), not just the
    // locally-configured `network` statements — audit 02: this used to
    // list configured networks verbatim with a fabricated next-hop
    // (0.0.0.0) regardless of whether they were ever actually learned
    // or reachable.
    const e = getRouter().getBGPEngine();
    getRouter().convergeDynamicRouting();
    const table = e.getBgpTable();
    const lines = [
      `BGP Local router ID : ${bgp.routerId ?? '0.0.0.0'}`,
      ' Total Number of Routes: ' + table.length,
      ' Network            NextHop         MED        LocPrf    PrefVal Path/Ogn',
    ];
    for (const r of table) {
      const prefix = `${r.network}/${r.mask.toCIDR()}`;
      const nextHop = String(r.nextHop ?? '0.0.0.0');
      const path = r.asPath.length ? `${r.asPath.join(' ')} i` : 'i';
      lines.push(` ${prefix.padEnd(19)}${nextHop.padEnd(16)}0          ${String(r.localPref).padEnd(10)}${String(r.weight).padEnd(8)}${path}`);
    }
    return lines.join('\n');
  });

  trie.register('display bgp group', 'Display BGP peer groups', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    const bgp = ex?.getBgp();
    if (!bgp || bgp.groups.size === 0) return 'Info: No BGP peer groups configured.';
    return [...bgp.groups.values()].map(g => `Group ${g.name}: kind=${g.kind ?? 'unspecified'} AS=${bgp.asn}`).join('\n');
  });
  trie.register('display bgp network', 'Display BGP advertised networks', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    const bgp = ex?.getBgp();
    if (!bgp || bgp.networks.length === 0) return 'Info: No BGP advertised networks.';
    return bgp.networks.map(n => `  ${n.ip}/${n.mask}`).join('\n');
  });
  trie.register('display bgp paths', 'Display BGP AS-paths', () => 'Info: No BGP paths.');
  trie.register('display bgp ipv6 peer', 'Display BGP IPv6 peers', () => 'Info: IPv6 BGP not running.');

  trie.register('display isis brief', 'Display IS-IS brief', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    const all = ex?.listIsis() ?? [];
    if (all.length === 0) return 'Info: IS-IS is not enabled.';
    return all.map(p => [
      `ISIS protocol information for system instance: ${p.processId}`,
      `  System Id : ${(p.netAddress ?? '').split('.').slice(3, 6).join('.') || '<unset>'}`,
      `  Level     : ${p.isLevel ?? 'Level-1-2'}`,
      `  Cost-style: ${p.costStyle ?? 'narrow'}`,
    ].join('\n')).join('\n');
  });
  trie.register('display isis interface', 'Display IS-IS interfaces', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'Interface           Type   IPv4 State Level     Cost                MTU\n(no IS-IS-enabled interfaces)';
  });
  trie.register('display isis lsdb', 'Display IS-IS LSDB', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'LSPID                 Seq Num     Checksum    Holdtime   Length   ATT/P/OL\n(no LSPs)';
  });
  trie.register('display isis peer', 'Display IS-IS peers', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'System ID         Interface          Circuit ID         State HoldTime Type     PRI\n(no peers established)';
  });
  trie.register('display isis route', 'Display IS-IS routing table', () => {
    const ex = getHuaweiRoutingExtras(getRouter());
    if (!ex?.listIsis().length) return 'Info: IS-IS is not enabled.';
    return 'Route information for ISIS\n  No routes installed';
  });

  trie.registerGreedy('display rip', 'Display RIP info', (args) => {
    if (args[1] === 'route') {
      if (!getRouter().isRIPEnabled()) return 'Info: RIP is not enabled.';
      const routes = getRouter().getRIPRoutes();
      const lines = ['  Peer       Family      Destination/Mask      Nexthop      Cost  Tag    Flags'];
      for (const [key, info] of routes) {
        lines.push(`  ${info.learnedFrom}      IPv4        ${key}      ${info.learnedFrom}    ${info.metric}     0      A`);
      }
      return lines.join('\n');
    }
    return displayRip(getRouter());
  });
  trie.register('display counters', 'Display traffic counters', () => displayCounters(getRouter()));
  trie.register('display rip', 'Display RIP information', () => displayRip(getRouter()));
  trie.register('display ip protocols', 'Display routing protocol status', () => displayIpProtocols(getRouter()));
  trie.register('display ip routing-table statistics', 'Display routing table statistics', () =>
    displayIpRoutingTableStatistics(getRouter()));

  trie.registerGreedy('display ip routing-table protocol', 'Filter routes by protocol', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpRoutingTableProtocol(getRouter(), args[0]);
  });

  trie.registerGreedy('display ip routing-table verbose', 'Verbose routing table', () =>
    displayIpRoutingTable(getRouter()));

  trie.register('display ip routing-table limit', 'Display routing table limit', () =>
    `Routing Table Limit:\n  Configured : unlimited\n  Current    : ${getRouter().getRoutingTable().length}`);

  trie.register('display router id', 'Display router id', () => {
    const ports = getRouter()._getPortsInternal();
    for (const [, p] of ports) {
      const ip = p.getIPAddress?.();
      if (ip) return `Router ID: ${ip}`;
    }
    return 'Router ID: 0.0.0.0';
  });

  trie.register('display fib', 'Display forwarding table', () => displayIpRoutingTable(getRouter()));

  trie.registerGreedy('display ipv6 routing-table protocol', 'Filter IPv6 routes by protocol', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpv6RoutingTableProtocol(getRouter(), args[0]);
  });

  trie.registerGreedy('display ip interface', 'Display IP interface details', (args) => {
    if (args.length === 0) return displayIpIntBrief(getRouter());
    const first = args[0].toLowerCase();
    if ('brief'.startsWith(first)) {
      const reste = args.slice(1).join(' ');
      return displayIpIntBrief(getRouter(), reste ? reste : undefined);
    }
    return displayIpInterface(getRouter(), args.join(' '));
  });

  trie.register('display debugging', 'Display active debugging flags', () =>
    displayDebugging(getRouter()));

  trie.register('display ipv6 routing-table', 'Display IPv6 routing table', () =>
    displayIpv6RoutingTable(getRouter()));

  trie.register('reset ipv6 neighbors', 'Clear IPv6 neighbour cache', () => {
    getRouter()._clearNeighborCache();
    return '';
  });

  trie.register('display ipv6 statistics', 'Display IPv6 packet statistics', () =>
    displayIpv6Statistics(getRouter()));
  trie.register('display icmpv6 statistics', 'Display ICMPv6 statistics', () =>
    displayIcmpv6Statistics(getRouter()));
  // Le nœud intermédiaire naît sans description : `display ?` proposait
  // `icmpv6` sans rien en dire. La description doit être posée APRÈS
  // l'enregistrement qui crée le nœud, sinon l'appel ne trouve rien.
  trie.describeNode('display icmpv6', 'ICMPv6 information');
  trie.register('reset ipv6 statistics', 'Clear IPv6 statistics', () => {
    getRouter()._clearIpv6Counters();
    return '';
  });

  trie.registerGreedy('display ipv6 neighbors', 'Display IPv6 neighbour cache', (args) => {
    if (args.length === 0) return displayIpv6Neighbors(getRouter());
    return displayIpv6Neighbors(getRouter(), args.join(' '));
  });

  trie.register('display ipv6 interface brief', 'Display IPv6 interface summary', () =>
    displayIpv6InterfaceBrief(getRouter()));

  trie.registerGreedy('display ipv6 interface', 'Display IPv6 interface detail', (args) => {
    if (args.length === 0) return displayIpv6InterfaceBrief(getRouter());
    return displayIpv6Interface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display current-configuration interface', 'Display interface running config', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayCurrentConfigInterface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display interface', 'Display interface information', (args) => {
    const sub = (args[0] || '').toLowerCase();
    if (args.length === 0) return displayInterfaceAll(getRouter());
    const reste = args.slice(1).join(' ').trim();
    if (sub === 'brief') return displayInterfaceBrief(getRouter(), reste || undefined);
    if (sub === 'description') return displayInterfaceDescription(getRouter(), reste || undefined);
    return displayInterface(getRouter(), args.join(' '));
  });

  trie.registerGreedy('display ip pool name', 'Display DHCP pool information', (args) => {
    if (args.length < 1) return 'Error: Incomplete command.';
    return displayIpPool(getRouter(), args.join(' '));
  });

  trie.register('display ip pool', 'Display all DHCP pools', () =>
    displayIpPoolAll(getRouter()));

  // ── Common VRP display commands (shared with the switch, DRY) ──
  trie.register('display clock', 'Display system clock', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const c = mgmt?.getClock();
    return commonDisplayClock(new Date(),
      c ? { timezone: c.timezone, offsetMin: c.offsetMin } : undefined);
  });
  trie.register('display cpu-usage', 'Display CPU usage', () => commonDisplayCpuUsage());
  trie.register('display memory-usage', 'Display memory usage', () => commonDisplayMemoryUsage());
  trie.register('display users', 'Display user sessions', () => commonDisplayUsers(getRouter()));
  trie.register('display device', 'Display device status', () =>
    commonDisplayDevice(getRouter().getHostname(), AR2220_HARDWARE_PROFILE));
  trie.register('display alarm', 'Display alarm records', () => commonDisplayAlarm());
  trie.register('display elabel', 'Display electronic label', () =>
    commonDisplayElabel(getRouter().getHostname(), AR2220_HARDWARE_PROFILE));
  trie.register('display license', 'Display license information', () => commonDisplayLicense());
  trie.registerGreedy('display logbuffer', 'Display log buffer', (args) => {
    if (args.length === 0) {
      return getState().renderLogbuffer?.() ?? commonDisplayLogbuffer();
    }
    if (args[0]?.toLowerCase() !== 'level' || args.length !== 2) {
      return `Error: Unrecognized command found at '^' position.`;
    }
    const seuil = normVrpSeverity(args[1]);
    if (seuil === null) return `Error: Wrong parameter found at '^' position.`;
    return getState().renderLogbuffer?.(VRP_SEVERITIES.indexOf(seuil)) ?? commonDisplayLogbuffer();
  });
  trie.addCompletionKeywords('display logbuffer', [
    { keyword: 'level', description: 'Lowest severity to display' },
  ]);
  trie.register('display trapbuffer', 'Display trap buffer', () => {
    const mgmt = (getRouter() as unknown as { getManagementService?: () => import('../../router/management/RouterManagementService').RouterManagementService }).getManagementService?.();
    const ic = mgmt?.getInfoCenter();
    if (!ic) return commonDisplayTrapbuffer();
    const canal = ic.destinationChannel.trapbuffer;
    return commonDisplayTrapbuffer({
      size: ic.trapbufferSize, channel: canal, channelName: ic.channelNames[canal],
    });
  });
  trie.register('display patch-information', 'Display patch information', () =>
    commonDisplayPatchInformation());
  trie.register('display diagnostic-information', 'Collect diagnostic information', () =>
    commonDisplayDiagnosticInformation());
}

// ─── Interface Name Resolution (Huawei format) ──────────────────────

/**
 * Resolve abbreviated Huawei interface name (backward-compatible wrapper).
 * Delegates to shared resolveHuaweiInterfaceName in cli-utils.
 */
export function resolveHuaweiInterfaceName(router: Router, input: string): string | null {
  return resolveHuaweiIfName(router.getPortNames(), input);
}

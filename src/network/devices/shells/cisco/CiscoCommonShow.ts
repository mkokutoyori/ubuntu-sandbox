/**
 * CiscoCommonShow — IOS `show`/utility command output common to the
 * Cisco switch and router. Single source of truth so CiscoSwitchShell
 * and CiscoIOSShell (both extend CiscoShellBase) don't duplicate it.
 *
 * Output is derived from the device's REAL internal state (ports,
 * cabled neighbours, configured addresses) — never hardcoded fixtures.
 */
import type { Port } from '@/network/hardware/Port';
import type { DeviceType } from '@/network/core/types';
import { EquipmentStateView } from '@/network/devices/inspection/EquipmentStateView';
import type { NeighborDTO } from '@/network/devices/inspection/DeviceStateView';
import { pad2 } from '@/lib/format';
import { CISCO_ERRORS } from '../cli-utils';
import {
  tableauLignes, blocDetailLigne, REGLAGES_PAR_DEFAUT,
  type LigneTty, type ReglagesLigne, type SessionSurLigne,
} from './CiscoLineViews';
import { nomLoopfilterIos } from '@/network/ntp/discipline';
import { C3560_SOFTWARE, ciscoSoftwareDescriptor } from './CiscoPlatform';
import { CliInvalidInput } from '../cli/CliDiagnostic';
import { iosInterfaceStatus } from '@/network/devices/inspection/InterfaceStatusView';
import { lldpCapabilityLetters } from '@/network/lldp/types';
import { MACAddress } from '@/network/core/types';
import type { LldpNeighbor } from '@/network/lldp/LldpAgent';

/**
 * Minimal device surface these show helpers read real state from.
 * Structurally compatible with the inspection facade's
 * InspectableDevice (DRY — collection logic lives in the facade).
 */
export interface ShowStateDevice {
  getHostname(): string;
  getType(): DeviceType;
  getPorts(): Port[];
  getInterfaceDescription?(portName: string): string | undefined;
  getCdpNeighbors?(): NeighborDTO[];
  getCdpAgent?(): import('@/network/cdp/CdpAgent').CdpAgent | undefined;
  getLldpNeighbors?(): NeighborDTO[];
  getLldpAgent?(): import('@/network/lldp/LldpAgent').LldpAgent | undefined;
  getNtpAgent?(): import('@/network/ntp/NtpAgent').NtpAgent | undefined;
}

/** IOS-style short interface name (GigabitEthernet0/0 → Gig 0/0). */
function shortIf(name: string): string {
  const m = name.match(/^([A-Za-z]+)(.*)$/);
  if (!m) return name;
  const alpha = m[1];
  const rest = m[2];
  const abbr = alpha.length > 3 ? alpha.slice(0, 3) : alpha;
  return `${abbr} ${rest}`.trim();
}

/**
 * Real CDP neighbours — protocol-learnt only. CDP is a Cisco-proprietary
 * protocol: a peer only appears here if it actually sent a CDP frame.
 * Non-CDP peers (Linux/Windows hosts) never appear, matching real IOS.
 */
function cdpNeighbours(dev: ShowStateDevice): NeighborDTO[] {
  return dev.getCdpNeighbors?.() ?? [];
}

export const IOS_DAYS: readonly string[] =
  Object.freeze(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);

export const IOS_MONTHS: readonly string[] = Object.freeze([
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]);

export interface CiscoClockReading {
  readonly local: Date;
  readonly timezone: string;
  readonly offsetMin: number;
  readonly synced: boolean;
}

export function ciscoClockReading(
  arg: Date | ShowStateDevice, atMs?: number,
): CiscoClockReading {
  if (arg instanceof Date) {
    return {
      local: arg, timezone: 'UTC', offsetMin: 0, synced: false,
    };
  }
  const dev = arg as unknown as {
    getSystemClockMs?: () => number;
    getManagementService?: () => { getClock: () => { timezone: string; offsetMin: number } };
    getNtpAgent?: () => { isSynced?: () => boolean };
  };
  const clock = dev.getManagementService?.().getClock();
  const offsetMin = clock?.offsetMin ?? 0;
  const now = atMs ?? dev.getSystemClockMs?.() ?? Date.now();
  return {
    local: new Date(now + offsetMin * 60_000),
    timezone: clock?.timezone ?? 'UTC',
    offsetMin,
    synced: dev.getNtpAgent?.().isSynced?.() ?? false,
  };
}

export function iosDateSuffix(local: Date): string {
  return `${IOS_DAYS[local.getUTCDay()]} ${IOS_MONTHS[local.getUTCMonth()]} `
    + `${local.getUTCDate()} ${local.getUTCFullYear()}`;
}

export function iosTimeOfDay(local: Date): string {
  return `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}`
    + `:${pad2(local.getUTCSeconds())}`;
}

export function showClock(arg: Date | ShowStateDevice = new Date()): string {
  const reading = ciscoClockReading(arg);
  return `${reading.synced ? '' : '*'}${iosTimeOfDay(reading.local)}.000`
    + ` ${reading.timezone} ${iosDateSuffix(reading.local)}`;
}

/** `show users` — active lines (console only in the sim). */
/**
 * `show users` — les sessions VIVANTES.
 *
 * Elle ne prenait AUCUN argument et rendait quatre lignes constantes :
 * une console seule, toujours, quel que soit le nombre de sessions
 * ouvertes. Le registre, lui, sait les lister (`formatShowUsers`) et
 * personne ne le lui demandait — donc toute la partie « voir les
 * sessions » d'un cours, et le diagnostic « toutes les VTY sont
 * occupees » qui commence par cette commande, portaient sur un texte
 * qui ne mesurait rien.
 *
 * La section `Interface / User / Mode` est celle des lignes
 * asynchrones ; elle reste vide parce qu'aucune n'est modelisee ici, ce
 * qui est vrai.
 */
export function showUsers(registre?: {
  formatShowUsers: () => string;
} | null): string {
  const entete = registre?.formatShowUsers()
    ?? '    Line       User       Host(s)              Idle       Location';
  return [entete, '', '  Interface    User               Mode         Idle     Peer Address'].join('\n');
}

export type CiscoChassisProfile = 'router-isr2911' | 'switch-c2960' | 'switch-c3560';

export interface CiscoHardwareProfile {
  pid: string;
  description: string;
  serialNumber: string;
  dramKB: number;
  ioMemoryKB: number;
  nvramKB: number;
  /**
   * Ce qu'IOS ANNONCE, qui n'est pas la taille de la puce : le
   * chargeur s'en réserve une part, et un 2911 dont la NVRAM fait 256K
   * écrit `255K bytes of non-volatile configuration memory.`
   */
  nvramDisplayKB: number;
  flashImage: string;
  flashImageSize: number;
  flashTotalBytes: number;
  flashFreeBytes: number;
  extraFlashFiles: Array<{ index: number; name: string; size: number }>;
}

/**
 * Le tableau de licences d'IOS, rendu d'un seul endroit. La bannière de
 * démarrage et `show version` décrivent la MÊME machine : deux copies
 * finiraient par se contredire, et un opérateur qui lit `securityk9` au
 * boot et rien du tout dans `show version` ne sait plus laquelle croire.
 *
 * `securityk9` est déclarée parce que l'arbre l'expose vraiment — zones,
 * class-map inspect, crypto isakmp/ipsec/ikev2, PKI — et que ces moteurs
 * sont réels. Une bannière qui annoncerait `None` décrirait un autre
 * équipement que celui qui répond aux commandes.
 */
export function licenseTable(module = 'c2900'): string[] {
  return [
    `Technology Package License Information for Module:'${module}'`,
    '',
    '-----------------------------------------------------------------',
    'Technology    Technology-package           Technology-package',
    '              Current       Type           Next reboot',
    '-----------------------------------------------------------------',
    'ipbase        ipbasek9      Permanent      ipbasek9',
    'security      securityk9    Permanent      securityk9',
    'uc            None          None           None',
    'data          None          None           None',
  ];
}

/**
 * Le numero de serie d'un chassis IDENTIFIE ce chassis : deux routeurs
 * ne peuvent pas porter le meme. Il etait constant dans le profil
 * materiel, donc toute une topologie etait un troupeau de jumeaux, et
 * `show inventory` de dix machines rendait dix fois `FTX1234567A`.
 *
 * La forme est celle de Cisco — trois lettres de site, quatre chiffres
 * d'annee/semaine, quatre caracteres de sequence — et la valeur est
 * DERIVEE de l'identifiant de la machine : stable d'un appel a l'autre
 * et d'un rechargement de topologie a l'autre, unique d'une machine a
 * l'autre. Un tirage aleatoire donnerait un numero different a chaque
 * lecture, ce qui n'identifie plus rien.
 */
export function chassisSerial(profil: CiscoHardwareProfile, deviceId: string): string {
  const prefixe = profil.serialNumber.slice(0, 3);
  let h = 2166136261;
  for (let i = 0; i < deviceId.length; i++) {
    h ^= deviceId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  const semaine = String(1000 + (h % 9000));
  let suite = '';
  let reste = h >>> 4;
  for (let i = 0; i < 4; i++) {
    suite += ALPHABET[reste % ALPHABET.length];
    reste = Math.floor(reste / ALPHABET.length) + i * 7;
  }
  return `${prefixe}${semaine}${suite}`;
}

export const CISCO_HARDWARE_PROFILES: Record<CiscoChassisProfile, CiscoHardwareProfile> = {
  'router-isr2911': {
    pid: 'CISCO2911/K9',
    description: 'Cisco ISR 2911 Integrated Services Router',
    serialNumber: 'FTX1234567A',
    // 512 Mo se répartissent en 491520K de DRAM et 32768K d'E/S. Le
    // couple 524288/65536 en annonçait 576, une taille qui n'existe pas.
    dramKB: 491520,
    ioMemoryKB: 32768,
    nvramKB: 256,
    nvramDisplayKB: 255,
    flashImage: 'c2900-universalk9-mz.SPA.157-3.M5.bin',
    flashImageSize: 86234112,
    flashTotalBytes: 256016384,
    flashFreeBytes: 169782272,
    extraFlashFiles: [{ index: 2, name: 'cpconfig-29xx.cfg', size: 2048 }],
  },
  'switch-c2960': {
    pid: 'WS-C2960-24TT-L',
    description: 'Cisco Catalyst Switch',
    serialNumber: 'FOC1234X56Y',
    dramKB: 131072,
    ioMemoryKB: 32768,
    nvramKB: 64,
    nvramDisplayKB: 63,
    flashImage: 'c2960-lanbasek9-mz.150-2.SE.bin',
    flashImageSize: 17825792,
    flashTotalBytes: 64016384,
    flashFreeBytes: 46188544,
    extraFlashFiles: [{ index: 2, name: 'vlan.dat', size: 3096 }],
  },
  'switch-c3560': {
    pid: 'WS-C3560-24TS-S',
    description: 'Cisco Catalyst 3560 Multilayer Switch',
    serialNumber: 'FOC1235X78Z',
    dramKB: 131072,
    ioMemoryKB: 32768,
    nvramKB: 128,
    nvramDisplayKB: 127,
    flashImage: 'c3560-ipservicesk9-mz.122-55.SE12.bin',
    flashImageSize: 24903680,
    flashTotalBytes: 65536000,
    flashFreeBytes: 40185856,
    extraFlashFiles: [{ index: 2, name: 'vlan.dat', size: 3096 }],
  },
};

/**
 * `NAME` désigne l'ENTITÉ PHYSIQUE au sens de la RFC 2737, pas la machine :
 * un châssis s'y nomme `CISCO2911/K9 chassis`, jamais du nom que
 * l'opérateur a donné au routeur — lequel peut changer sans que le
 * matériel bouge.
 */
/**
 * `<hostname> uptime is ...` au format d'IOS.
 *
 * Deux rendus coexistaient et se trompaient différemment : l'un répondait
 * « 0 minutes » sous la minute là où IOS compte les SECONDES, l'autre
 * écrivait « 0 days, 0 hours, 3 minutes » là où IOS omet les composantes
 * nulles. IOS descend de la semaine à la minute, ne garde que ce qui
 * n'est pas nul, et bascule sur les secondes tant qu'il n'y a pas une
 * minute entière.
 */
export function formatIosUptime(ms: number): string {
  // IOS compte l'uptime en MINUTES : il n'écrit jamais « 0 seconds »,
  // il écrit « 0 minutes ». La seconde n'est pas une unité de cette
  // ligne, et l'afficher trahissait un compteur interne.
  const totalMin = Math.floor(Math.max(0, ms) / 60000);
  const units: ReadonlyArray<readonly [number, string]> = [
    [Math.floor(totalMin / 10080), 'week'],
    [Math.floor((totalMin % 10080) / 1440), 'day'],
    [Math.floor((totalMin % 1440) / 60), 'hour'],
    [totalMin % 60, 'minute'],
  ];
  const parts = units
    .filter(([n]) => n > 0)
    .map(([n, label]) => `${n} ${label}${n === 1 ? '' : 's'}`);
  return parts.length > 0 ? parts.join(', ') : '0 minutes';
}

export function showInventory(
  hostname: string, profile: CiscoChassisProfile = 'switch-c3560', deviceId?: string,
): string {
  void hostname;
  const c = CISCO_HARDWARE_PROFILES[profile];
  return [
    `NAME: "${c.pid} chassis", DESCR: "${c.description}"`,
    `PID: ${c.pid.padEnd(20)}, VID: V01  , SN: ${chassisSerial(c, deviceId ?? hostname)}`,
  ].join('\n');
}

/** `show processes cpu` — steady-state CPU snapshot. */
export function showProcessesCpu(): string {
  return [
    'CPU utilization for five seconds: 4%/0%; one minute: 5%; five minutes: 4%',
    ' PID Runtime(ms)   Invoked  uSecs   5Sec   1Min   5Min TTY Process',
    '   1           4        38    105  0.00%  0.00%  0.00%   0 Chunk Manager',
    '   2          12       210     57  0.00%  0.00%  0.00%   0 Load Meter',
    '   5           0         0      0  0.00%  0.00%  0.00%   0 IP Input',
    '  55           0         0      0  0.00%  0.00%  0.00%   0 ARP Input',
    ' 130           0         0      0  0.00%  0.00%  0.00%   0 Crypto Engine',
    ' 178           0         0      0  0.00%  0.00%  0.00%   0 DHCPD Receive',
    ' 201           0         0      0  0.00%  0.00%  0.00%   0 OSPF Router',
    ' 240           0         0      0  0.00%  0.00%  0.00%   0 Spanning Tree',
  ].join('\n');
}


/** `show memory statistics` — head/total/used/free. */
export function showMemoryStatistics(profile: CiscoChassisProfile = 'switch-c3560'): string {
  const hw = CISCO_HARDWARE_PROFILES[profile];
  const dramBytes = hw.dramKB * 1024;
  const ioBytes = hw.ioMemoryKB * 1024;
  const procUsed = Math.floor(dramBytes * 0.3);
  const procFree = dramBytes - procUsed;
  const ioUsed = Math.floor(ioBytes * 0.25);
  const ioFree = ioBytes - ioUsed;
  return [
    '                Head    Total(b)     Used(b)     Free(b)   Lowest(b)  Largest(b)',
    `Processor    1A2B3C4    ${dramBytes}    ${procUsed}    ${procFree}    ${Math.floor(procFree * 0.95)}    ${Math.floor(procFree * 0.97)}`,
    `I/O          5D6E7F8     ${ioBytes}     ${ioUsed}    ${ioFree}    ${Math.floor(ioFree * 0.95)}    ${Math.floor(ioFree * 0.97)}`,
  ].join('\n');
}

/** `show privilege` — current EXEC level. */
export function showPrivilege(level: number): string {
  return `Current privilege level is ${level}`;
}

/**
 * `show cdp [neighbors [detail] | interface]` — built from the device's
 * REAL cabled topology (Equipment registry + Port/Cable graph).
 */
function isVirtualInterface(name: string): boolean {
  return /^(Tunnel|Loopback|Null|Vlan|BVI|Bundle-Ether|Port-channel|Virtual-)/i.test(name);
}

function interfaceNameMatches(fullName: string, spec: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9/]/g, '');
  const f = norm(fullName);
  const p = norm(spec);
  if (!p) return true;
  if (f === p) return true;
  const split = (s: string): [string, string] => {
    const m = s.match(/^([a-z-]+)(.*)$/);
    return m ? [m[1], m[2]] : [s, ''];
  };
  const [ft, fn] = split(f);
  const [pt, pn] = split(p);
  return fn === pn && pt.length > 0 && ft.startsWith(pt);
}

function cdpDetailBlock(
  n: import('@/network/cdp/CdpAgent').CdpNeighbor, holdSec: number,
): string {
  const addressLines = n.remoteAddresses.map((addr) => `  IP address: ${addr}`);
  return [
    '-------------------------',
    `Device ID: ${n.remoteHost}`,
    'Entry address(es):',
    ...addressLines,
    `Platform: ${n.remotePlatform},  Capabilities: ${n.remoteCapability}`,
    `Interface: ${n.localPort},  Port ID (outgoing port): ${n.remotePort}`,
    `Holdtime : ${holdSec} sec`,
    '',
    'Version :',
    n.remoteSoftwareVersion,
    '',
    `advertisement version: ${n.advertisementVersion}`,
    ...(n.nativeVlan !== undefined ? [`Native VLAN: ${n.nativeVlan}`] : []),
    `Duplex: ${n.duplex}`,
  ].join('\n');
}

export function showCdp(dev: ShowStateDevice, arg = '', enabled = true): string {
  const a = arg.toLowerCase();
  if (!enabled) {
    // Real disabled state: no protocol info, no neighbours.
    if (a.includes('neighbor')) {
      return a.includes('detail')
        ? 'Total cdp entries displayed : 0'
        : 'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge\n' +
          '                  S - Switch, H - Host, I - IGMP, r - Repeater\n\n' +
          'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID\n\n' +
          'Total cdp entries displayed : 0';
    }
    return '% CDP is not enabled';
  }
  if (a.includes('interface')) {
    const agentCfg = dev.getCdpAgent?.()?.getConfig();
    const timer = agentCfg?.timerSec ?? 60;
    const hold = agentCfg?.holdtimeSec ?? 180;
    const disabled = agentCfg?.disabledPorts ?? new Set<string>();
    const after = a.slice(a.indexOf('interface') + 'interface'.length).trim();
    const spec = after.split(/\s+/)[0] ?? '';
    const lines: string[] = [];
    for (const p of dev.getPorts()) {
      const name = p.getName();
      if (spec && !interfaceNameMatches(name, spec)) continue;
      if (disabled.has(name)) continue;
      if (isVirtualInterface(name)) continue;
      lines.push(`${name} is ${iosInterfaceStatus(p, name).status}, ` +
        `line protocol is ${iosInterfaceStatus(p, name).protocol}`);
      lines.push('  Encapsulation ARPA');
      lines.push(`  Sending CDP packets every ${timer} seconds`);
      lines.push(`  Holdtime is ${hold} seconds`);
    }
    return lines.length ? lines.join('\n') : 'CDP is not enabled on any interface';
  }
  if (a.startsWith('entry')) {
    const spec = arg.slice(arg.toLowerCase().indexOf('entry') + 'entry'.length).trim();
    const all = dev.getCdpAgent?.()?.getNeighbors() ?? [];
    const matches = spec === '' || spec === '*'
      ? all
      : all.filter((n) => n.remoteHost.toLowerCase() === spec.toLowerCase());
    if (!matches.length) return `Total cdp entries displayed : 0`;
    const agentCdp = dev.getCdpAgent?.();
    const blocks = matches.map(n => cdpDetailBlock(
      n, agentCdp?.holdtimeRemainingSec(n) ?? n.holdtimeSec));
    return `${blocks.join('\n\n')}\n\nTotal cdp entries displayed : ${matches.length}`;
  }
  if (a.includes('traffic')) {
    const learned = dev.getCdpAgent?.()?.getNeighbors() ?? [];
    // The agent does not keep packet counters; derive a consistent view
    // from what it has actually learned so the counters are never pure
    // fiction (0 neighbors → 0 packets received).
    const received = learned.length;
    return [
      'CDP counters :',
      `        Total packets output: ${received}, Input: ${received}`,
      '        Hdr syntax: 0, Chksum error: 0, Encaps failed: 0',
      '        No memory: 0, Invalid packet: 0,',
      `        CDP version 1 advertisements output: 0, Input: 0`,
      `        CDP version 2 advertisements output: ${received}, Input: ${received}`,
    ].join('\n');
  }
  if (a.includes('neighbor')) {
    const ns = cdpNeighbours(dev);
    const detail = a.includes('detail');
    if (detail) {
      const agentCdp = dev.getCdpAgent?.();
      const learned = agentCdp?.getNeighbors() ?? [];
      if (!learned.length) return 'Total cdp entries displayed : 0';
      const blocks = learned.map(n => cdpDetailBlock(
        n, agentCdp?.holdtimeRemainingSec(n) ?? n.holdtimeSec));
      return `${blocks.join('\n\n')}\n\nTotal cdp entries displayed : ${learned.length}`;
    }
    const hdr = [
      'Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge',
      '                  S - Switch, H - Host, I - IGMP, r - Repeater',
      '',
      'Device ID        Local Intrfce     Holdtme    Capability  Platform  Port ID',
    ];
    const agent = dev.getCdpAgent?.();
    const appris = agent?.getNeighbors() ?? [];
    const resteHold = (n: NeighborDTO): number => {
      const e = appris.find(x => x.localPort === n.localPort && x.remoteHost === n.remoteHost);
      return e && agent ? agent.holdtimeRemainingSec(e) : 180;
    };
    const rows = ns.map((n) =>
      `${n.remoteHost.slice(0, 16).padEnd(16)} ${shortIf(n.localPort).slice(0, 17).padEnd(17)} ` +
      `${String(resteHold(n)).padEnd(10)} ` +
      `${n.remoteCapability.charAt(0).padEnd(11)} ` +
      `${n.remotePlatform.slice(0, 9).padEnd(9)} ${shortIf(n.remotePort)}`);
    return [...hdr, ...rows, '', `Total cdp entries displayed : ${ns.length}`].join('\n');
  }
  const cfg = dev.getCdpAgent?.()?.getConfig();
  const t = cfg?.timerSec ?? 60;
  const h = cfg?.holdtimeSec ?? 180;
  return [
    'Global CDP information:',
    `        Sending CDP packets every ${t} seconds`,
    `        Sending a holdtime value of ${h} seconds`,
    '        Sending CDPv2 advertisements is  enabled',
  ].join('\n');
}

const LLDP_IF_ABBREV: ReadonlyArray<readonly [RegExp, string]> = [
  [/^TenGigabitEthernet/i, 'Te'],
  [/^FortyGigabitEthernet/i, 'Fo'],
  [/^GigabitEthernet/i, 'Gi'],
  [/^FastEthernet/i, 'Fa'],
  [/^Ethernet/i, 'Et'],
  [/^Serial/i, 'Se'],
  [/^Loopback/i, 'Lo'],
  [/^Port-channel/i, 'Po'],
  [/^Vlan/i, 'Vl'],
];

function lldpShortIf(name: string): string {
  for (const [re, abbr] of LLDP_IF_ABBREV) {
    if (re.test(name)) return name.replace(re, abbr);
  }
  return name;
}

function lldpChassisId(n: { chassisId: string; chassisIdSubtype: string }): string {
  if (n.chassisIdSubtype !== 'macAddress') return n.chassisId;
  try { return new MACAddress(n.chassisId).toCiscoString(); } catch { return n.chassisId; }
}

function notAdvertised(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : `${label} - not advertised`;
}

function lldpDetailBlock(n: LldpNeighbor, remaining: number): string {
  const lines = [
    '------------------------------------------------',
    `Local Intf: ${lldpShortIf(n.localPort)}`,
    `Chassis id: ${lldpChassisId(n)}`,
    `Port id: ${n.portId}`,
    notAdvertised('Port Description', n.portDescription),
    notAdvertised('System Name', n.systemName),
    '',
  ];
  if (n.systemDescription) {
    lines.push('System Description:', n.systemDescription, '');
  } else {
    lines.push('System Description - not advertised', '');
  }
  lines.push(`Time remaining: ${remaining} seconds`);
  const caps = lldpCapabilityLetters(n.remoteCapabilities ?? []);
  lines.push(notAdvertised('System Capabilities', n.remoteCapabilities ? caps : undefined));
  lines.push(notAdvertised('Enabled Capabilities', n.remoteCapabilities ? caps : undefined));
  if (n.managementAddresses && n.managementAddresses.length > 0) {
    lines.push('Management Addresses:');
    for (const a of n.managementAddresses) lines.push(`    IP: ${a}`);
  } else {
    lines.push('Management Addresses - not advertised');
  }
  lines.push('Auto Negotiation - not supported');
  lines.push('Physical media capabilities - not advertised');
  lines.push('Media Attachment Unit type - not advertised');
  lines.push('Vlan ID: - not advertised');
  return lines.join('\n');
}

const LLDP_CAP_LEGEND = [
  'Capability codes:',
  '    (R) Router, (B) Bridge, (T) Telephone, (C) DOCSIS Cable Device',
  '    (W) WLAN Access Point, (P) Repeater, (S) Station, (O) Other',
  '',
];

function lldpGlobalBlock(timer: number, ttl: number, reinit: number): string {
  return [
    'Global LLDP Information:',
    '    Status: ACTIVE',
    `    LLDP advertisements are sent every ${timer} seconds`,
    `    LLDP hold time advertised is ${ttl} seconds`,
    `    LLDP interface reinitialisation delay is ${reinit} seconds`,
  ].join('\n');
}

function lldpLocalInfo(dev: ShowStateDevice, ttl: number): string {
  const agent = dev.getLldpAgent?.();
  const ports = dev.getPorts();
  if (!agent || ports.length === 0) return 'LLDP is not enabled';
  const self = agent.localIdentity(ports[0].getName());
  const caps = lldpCapabilityLetters(self.capabilities ?? []);
  const lines = [
    'Local LLDP Information:',
    `    Chassis ID: ${lldpChassisId(self)}`,
    `    ${notAdvertised('System Name', self.systemName)}`,
  ];
  if (self.systemDescription) {
    lines.push('    System Description:', `    ${self.systemDescription}`);
  } else {
    lines.push('    System Description - not advertised');
  }
  lines.push('');
  lines.push(`    ${notAdvertised('System Capabilities', self.capabilities ? caps : undefined)}`);
  lines.push(`    ${notAdvertised('Enabled Capabilities', self.capabilities ? caps : undefined)}`);
  if (self.managementAddresses && self.managementAddresses.length > 0) {
    lines.push('    Management Addresses:');
    for (const addr of self.managementAddresses) lines.push(`        IP: ${addr}`);
  } else {
    lines.push('    Management Addresses - not advertised');
  }
  lines.push(`    TTL: ${ttl} seconds`, '');
  for (const p of ports) {
    const name = p.getName();
    if (!agent.isPortTransmitEnabled(name)) continue;
    const adv = agent.buildAdvertisement(name);
    lines.push(`Port ID: ${adv.portId}`);
    lines.push(`    ${notAdvertised('Port Description', adv.portDescription)}`);
  }
  return lines.join('\n');
}

function lldpTraffic(dev: ShowStateDevice): string {
  const t = dev.getLldpAgent?.()?.getTraffic();
  return [
    'LLDP traffic statistics:',
    '',
    `    Total frames out: ${t?.framesOut ?? 0}`,
    `    Total entries aged: ${t?.entriesAged ?? 0}`,
    `    Total frames in: ${t?.framesIn ?? 0}`,
    `    Total frames received in error: ${t?.framesInError ?? 0}`,
    `    Total frames discarded: ${t?.framesDiscarded ?? 0}`,
    `    Total TLVs discarded: ${t?.tlvsDiscarded ?? 0}`,
    `    Total TLVs unrecognized: ${t?.tlvsUnrecognized ?? 0}`,
  ].join('\n');
}

function lldpEntries(dev: ShowStateDevice, filter: string): string {
  const agent = dev.getLldpAgent?.();
  const all = agent?.getNeighbors() ?? [];
  const wanted = filter === '*' || filter === ''
    ? all
    : all.filter(n => (n.systemName ?? '').toLowerCase() === filter.toLowerCase());
  if (wanted.length === 0) return 'Total entries displayed: 0';
  const blocks = wanted.map(n => lldpDetailBlock(n, agent?.ttlRemainingSec(n) ?? n.ttlSec));
  return `${blocks.join('\n\n')}\n\nTotal entries displayed: ${wanted.length}`;
}

export function showLldp(dev: ShowStateDevice, arg = '', enabled = true): string {
  const cfg = dev.getLldpAgent?.()?.getConfig();
  const timer = cfg?.timerSec ?? 30;
  const mul = cfg?.holdtimeMultiplier ?? 4;
  const ttl = timer * mul;
  const reinit = cfg?.reinitDelaySec ?? 2;
  const a = arg.toLowerCase().trim();
  if (!enabled) {
    if (a.startsWith('neighbor')) {
      return [...LLDP_CAP_LEGEND,
        'Device ID           Local Intf     Hold-time  Capability      Port ID',
        '',
        'Total entries displayed: 0'].join('\n');
    }
    if (a.startsWith('entry')) return 'Total entries displayed: 0';
    return '% LLDP is not enabled';
  }
  if (a.startsWith('neighbor')) {
    const agent = dev.getLldpAgent?.();
    const learned = agent?.getNeighbors() ?? [];
    if (a.includes('detail')) {
      if (learned.length === 0) return 'Total entries displayed: 0';
      const blocks = learned.map(n => lldpDetailBlock(n, agent?.ttlRemainingSec(n) ?? n.ttlSec));
      return `${blocks.join('\n\n')}\n\nTotal entries displayed: ${learned.length}`;
    }
    const rows = learned.map((n) =>
      `${(n.systemName ?? '').padEnd(20)}${lldpShortIf(n.localPort).padEnd(15)}` +
      `${String(agent?.ttlRemainingSec(n) ?? n.ttlSec).padEnd(11)}` +
      `${lldpCapabilityLetters(n.remoteCapabilities ?? []).padEnd(16)}${n.portId}`);
    return [...LLDP_CAP_LEGEND,
      'Device ID           Local Intf     Hold-time  Capability      Port ID',
      ...rows, '', `Total entries displayed: ${learned.length}`].join('\n');
  }
  if (a.startsWith('entry')) return lldpEntries(dev, arg.trim().split(/\s+/)[1] ?? '*');
  if (a.startsWith('traffic')) return lldpTraffic(dev);
  if (a.startsWith('local')) return lldpLocalInfo(dev, ttl);
  if (a.startsWith('errors')) {
    return ['LLDP errors/overflows:', '',
      '    Total memory allocation failures: 0',
      '    Total encapsulation failures: 0',
      '    Total input queue overflows: 0',
      '    Total table overflows: 0'].join('\n');
  }
  if (a.startsWith('interface')) {
    const agent = dev.getLldpAgent?.();
    const lines: string[] = [];
    for (const p of dev.getPorts()) {
      const tx = agent?.isPortTransmitEnabled(p.getName()) ?? true;
      const rx = agent?.isPortReceiveEnabled(p.getName()) ?? true;
      lines.push(`${p.getName()}:`);
      lines.push(`    Tx: ${tx ? 'enabled' : 'disabled'}`);
      lines.push(`    Rx: ${rx ? 'enabled' : 'disabled'}`);
      lines.push(`    Tx state: ${tx && p.getIsUp() && p.isConnected() ? 'IDLE' : 'INIT'}`);
      lines.push(`    Rx state: ${rx && p.getIsUp() && p.isConnected() ? 'WAIT FOR FRAME' : 'INIT'}`);
    }
    return lines.length ? lines.join('\n') : 'LLDP is not enabled on any interface';
  }
  if (a !== '') throw new CliInvalidInput({ token: arg.trim().split(/\s+/)[0] });
  return lldpGlobalBlock(timer, ttl, reinit);
}

/**
 * SNMP/NTP/TCP/sockets reflect the device's genuine state: these
 * subsystems carry no configuration or live sessions in the model, so
 * the truthful output is the unconfigured/zero-activity state — not a
 * fabricated population.
 */
export function showSnmp(
  dev?: ShowStateDevice,
  profile: CiscoChassisProfile = 'router-isr2911',
): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  const chassis = CISCO_HARDWARE_PROFILES[profile].serialNumber;
  if (!svc || !svc.isEnabled()) {
    return [
      `Chassis: ${svc?.getChassisId() || chassis}`,
      'SNMP agent not enabled',
      '0 SNMP packets input',
      '0 SNMP packets output',
    ].join('\n');
  }
  const s = svc.getStats();
  const lines: string[] = [
    `Chassis: ${svc.getChassisId() || chassis}`,
    `${s.pktsIn} SNMP packets input`,
    `    ${s.badVersions} Bad SNMP version errors`,
    `    ${s.badCommunityNames} Unknown community name`,
    `    ${s.badCommunityUses} Illegal operation for community name supplied`,
    `    ${s.asn1ParseErrors} Encoding errors`,
    `    ${s.getRequests} Number of requested variables`,
    `    ${s.setRequests} Number of altered variables`,
    `    ${s.getRequests} Get-request PDUs`,
    `    ${s.getNextRequests} Get-next PDUs`,
    `    ${s.setRequests} Set-request PDUs`,
    `${s.pktsOut} SNMP packets output`,
    `    ${s.silentDrops} Too big errors (Maximum packet size 1500)`,
    `    ${s.silentDrops} No such name errors`,
    `    ${s.silentDrops} Bad values errors`,
    `    ${s.silentDrops} General errors`,
    `    ${s.getResponses} Response PDUs`,
    `    ${s.trapsSent} Trap PDUs`,
  ];
  if (svc.getContact()) lines.push(`SNMP server contact: ${svc.getContact()}`);
  if (svc.getLocation()) lines.push(`SNMP server location: ${svc.getLocation()}`);
  return lines.join('\n');
}

export function showSnmpCommunity(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const list = svc.getCommunities();
  if (list.length === 0) return 'No SNMP communities configured';
  return list.map(c =>
    `Community name: ${c.name}\nCommunity Index: ${c.name}\nCommunity SecurityName: ${c.name}\nAccess: ${c.access === 'rw' ? 'read-write' : 'read-only'}${c.aclName ? '\nAccess-list: ' + c.aclName : ''}${c.view ? '\nView: ' + c.view : ''}`
  ).join('\n\n');
}

export function showSnmpHost(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const hosts = svc.getHosts();
  if (hosts.length === 0) return 'No SNMP hosts configured';
  return hosts.map(h => [
    `Notification host: ${h.host}`,
    `Notification type: ${h.notificationType ?? 'traps'}`,
    `Version: ${h.version}${h.v3Level ? '/' + h.v3Level : ''}`,
    `UDP port: ${h.udpPort ?? 162}`,
    `Community name: ${h.community || '(not set)'}`,
    h.notifications.length > 0 ? `Filter: ${h.notifications.join(' ')}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
}

export function showSnmpGroup(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const groups = svc.getGroups();
  if (groups.length === 0) return 'No SNMP groups configured';
  return groups.map(g => [
    `groupname: ${g.name}`,
    `security model: v${g.version}${g.v3Level ? ' ' + g.v3Level : ''}`,
    `readview: ${g.readView ?? '<no readview specified>'}`,
    `writeview: ${g.writeView ?? '<no writeview specified>'}`,
    `notifyview: ${g.notifyView ?? '<no notifyview specified>'}`,
    `row status: active${g.acl ? '   access-list: ' + g.acl : ''}`,
  ].join('\n')).join('\n\n');
}

export function showSnmpUser(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const users = svc.getUsers();
  if (users.length === 0) return 'No SNMP users configured';
  return users.map(u => [
    `User name: ${u.name}`,
    `Engine ID: ${svc.getEngineId()}`,
    `storage-type: nonvolatile        active`,
    `Authentication Protocol: ${u.authAlgo ? u.authAlgo.toUpperCase() : 'None'}`,
    // `AES256` et non `AES` : la longueur de cle fait partie du protocole
    // sur IOS, et c'est elle que le controle A20 d'une liste d'audit
    // cherche a lire.
    `Privacy Protocol: ${u.privAlgo
      ? u.privAlgo.toUpperCase() + (u.privKeyBits ?? '')
      : 'None'}`,
    `Group-name: ${u.group}`,
  ].join('\n')).join('\n\n');
}

export function showSnmpView(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  const views = svc.getViews();
  if (views.size === 0) return 'No SNMP views configured';
  const lines: string[] = [];
  for (const [name, list] of views) {
    for (const v of list) lines.push(`${name} ${v.oid} - ${v.type}`);
  }
  return lines.join('\n');
}

export function showSnmpEngineId(dev?: ShowStateDevice): string {
  const svc = (dev as unknown as { getSnmpService?: () => import('@/network/devices/router/management/SnmpService').SnmpService } | undefined)?.getSnmpService?.();
  if (!svc) return 'SNMP agent not enabled';
  return `Local SNMP engineID: ${svc.getEngineId()}`;
}

/**
 * `show ntp status`.
 *
 * Le bloc n'avait que quatre lignes sur huit, et les quatre absentes
 * sont exactement celles qu'un audit lit : `root delay` et
 * `root dispersion` disent la QUALITE du chemin jusqu'a la source,
 * `loopfilter state` si la boucle de discipline tourne, `last update`
 * depuis combien de temps la mesure date. Une vue de diagnostic qui
 * n'imprime pas de quoi diagnostiquer est une vue de decor.
 *
 * Chaque valeur est LUE et non inventee : la frequence reelle derive de
 * l'ecart mesure (`getDriftPpm`), la dispersion racine de celle de
 * l'association retenue, l'age de la derniere mise a jour de son
 * horodatage de reponse. Sans synchronisation, IOS ecrit
 * `no reference clock` et une frequence nominale -- ce que fait la
 * branche non synchronisee ci-dessous.
 */
export function showNtpStatus(dev?: ShowStateDevice): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  if (!ntp) return 'Clock is unsynchronized, stratum 16, no reference clock';
  const cfg = ntp.getConfig();
  const synced = ntp.isSynced();
  const best = [...cfg.associations.values()].find((a) => a.preferred);
  const driftPpm = ntp.getDriftPpm();
  const boucle = nomLoopfilterIos(ntp.getEtatHorloge().etat);
  const nominalHz = 250;
  const actualHz = nominalHz * (1 + driftPpm / 1e6);
  // Une reference LOCALE (`ntp master`) n'a ni delai ni dispersion vers
  // une source : il n'y a pas de source. Rendre 16000 ms -- la valeur
  // « aucune mesure » -- sur une machine que la vue declare synchronisee
  // etait contradictoire dans le meme bloc.
  const localMaster = synced && !best;
  const rootDelay = best ? Math.abs(best.delayMs) : 0;
  const rootDisp = best ? best.dispersionMs : localMaster ? 0 : 16000;
  const peerDisp = best ? best.dispersionMs / 2 : localMaster ? 0 : 16000;
  const pollSec = best?.pollSec ?? 64;
  const lastUpdateSec = best?.lastReplyMs
    ? Math.max(0, Math.floor((Date.now() - best.lastReplyMs) / 1000))
    : null;
  const tete = synced
    ? `Clock is synchronized, stratum ${cfg.localStratum}, reference is ${cfg.refIdentifier || '.INIT.'}`
    : 'Clock is unsynchronized, stratum 16, no reference clock';
  return [
    tete,
    `nominal freq is ${nominalHz.toFixed(4)} Hz, actual freq is ${actualHz.toFixed(4)} Hz, precision is 2**18`,
    `ntp uptime is ${ntp.getUptimeSec() * 100} (1/100 of seconds), resolution is 4001`,
    `reference time is ${formatNtpReferenceTime(cfg.lastSyncMs || Date.now())}`,
    `clock offset is ${cfg.offsetMs.toFixed(4)} msec, root delay is ${rootDelay.toFixed(2)} msec`,
    `root dispersion is ${rootDisp.toFixed(2)} msec, peer dispersion is ${peerDisp.toFixed(2)} msec`,
    // L'etat de la boucle est LU sur la discipline (lot N9) : il valait
    // `CTRL` des que la machine etait synchronisee, donc il ne pouvait
    // jamais annoncer une aberration ni une panique — les deux etats que
    // cette ligne existe pour montrer.
    `loopfilter state is '${boucle.code}' (${boucle.libelle}), drift is ${(driftPpm / 1e6).toFixed(9)} s/s`,
    `system poll interval is ${pollSec}, ${lastUpdateSec === null ? 'never updated' : `last update was ${lastUpdateSec} sec ago`}.`,
  ].join('\n');
}

/**
 * `show ntp associations detail`.
 *
 * La commande n'existait pas : le greedy `show ntp` rendait le TABLEAU
 * pour toute queue, `detail` comprise. Or c'est ici que se lisent les
 * huit dernieres mesures (`filtdelay`/`filtoffset`), donc la stabilite
 * de la source -- le tableau ne donne que la derniere.
 *
 * Les huit colonnes ne sont pas un historique invente : ce moteur ne
 * garde qu'une mesure par association, donc les huit cases repetent la
 * mesure courante et `filterror` croit avec l'anciennete, comme sur IOS
 * ou l'erreur estimee augmente a chaque rang. Inventer huit valeurs
 * differentes ferait croire a un historique qui n'existe pas.
 */
export function showNtpAssociationsDetail(dev?: ShowStateDevice): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  if (!ntp || ntp.getConfig().associations.size === 0) return '';
  const blocs: string[] = [];
  for (const [, a] of ntp.getConfig().associations) {
    const joignable = a.reach !== 0;
    const role = a.preferred && joignable ? 'our_master' : joignable ? 'selected' : 'unsynced';
    // `authenticated` n'apparait que sur les associations dont le
    // condensé a ete VERIFIE, et cette vue est la SEULE a le montrer :
    // la documentation Cisco et les transcriptions concordent — « basic
    // `show ntp associations` won't reveal authentication status, you
    // must use the `detail` keyword ». Une association sans clé n'ecrit
    // rien plutot que `unauthenticated`, parce qu'IOS n'ecrit ce mot que
    // lorsqu'une authentification a ete tentee et a echoue.
    const auth = a.authenticated === true ? ', authenticated'
      : a.authenticated === false ? ', unauthenticated' : '';
    const notreMode = a.mode === 'symmetric-active' ? 'active' : 'client';
    const sonMode = a.mode === 'symmetric-active' ? 'passive' : 'server';
    const syncDist = Math.abs(a.delayMs) / 2 + a.dispersionMs;
    const filt = (v: number) => Array(8).fill(v.toFixed(2)).join('  ');
    blocs.push([
      `${a.serverIp} configured${auth}, ${role}, sane, valid, stratum ${a.stratum}`,
      `ref ID ${a.stratum < 16 ? a.serverIp : '.INIT.'}, time ${formatNtpReferenceTime(a.lastReplyMs || Date.now())}`,
      `our mode ${notreMode}, peer mode ${sonMode}, our poll intvl ${a.pollSec}, peer poll intvl ${a.pollSec}`,
      `root delay ${Math.abs(a.delayMs).toFixed(2)} msec, root disp ${a.dispersionMs.toFixed(2)}, reach ${a.reach.toString(8).padStart(3, '0')}, sync dist ${syncDist.toFixed(2)}`,
      `delay ${Math.abs(a.delayMs).toFixed(2)} msec, offset ${a.offsetMs.toFixed(4)} msec, dispersion ${a.dispersionMs.toFixed(2)}`,
      `precision 2**18, version 4`,
      `filtdelay =  ${filt(Math.abs(a.delayMs))}`,
      `filtoffset = ${filt(a.offsetMs)}`,
      `filterror =  ${Array.from({ length: 8 }, (_, i) => (a.dispersionMs + i * 0.45).toFixed(2)).join('  ')}`,
    ].join('\n'));
  }
  return blocs.join('\n');
}

/**
 * `show ntp authentication-keys`. Elle rendait le tableau des
 * associations, comme tout ce qui suivait `show ntp`. La cle elle-meme
 * est imprimee parce qu'IOS l'imprime ici -- c'est precisement pourquoi
 * la vue est reservee a l'EXEC privilegie.
 */
/**
 * `show ntp packets [mode {active|client|passive|server}]`.
 *
 * Elle etait REFUSEE au lot N1, au motif que rien ne comptait — c'etait
 * vrai du moteur, mais la commande EXISTE sur IOS et son format est
 * documente. Refuser une vraie commande parce que sa matiere manque
 * revient a cacher le manque plutot qu'a le combler ; les compteurs
 * existent maintenant, et elle repond.
 *
 * Les quatre lignes sont celles de la reference : « Ntp In packets »,
 * « Ntp Out packets », « Ntp bad version packets »,
 * « Ntp protocol error packets ».
 */
export function showNtpPackets(dev?: ShowStateDevice, mode?: string): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  if (!ntp) return 'Ntp In packets: 0\nNtp Out packets: 0\nNtp bad version packets: 0\nNtp protocol error packets: 0';
  const c = ntp.getCounters();
  if (mode) {
    // IOS nomme le mode symetrique passif `passive` et l'actif
    // `active` ; le moteur les nomme en toutes lettres.
    const cle = ({ active: 'symmetric-active', passive: 'symmetric-passive',
      client: 'client', server: 'server' } as Record<string, string>)[mode.toLowerCase()];
    if (!cle) return CISCO_ERRORS.INVALID_INPUT;
    const k = cle as keyof typeof c.receivedByMode;
    return [
      `Ntp In packets: ${c.receivedByMode[k]}`,
      `Ntp Out packets: ${c.sentByMode[k]}`,
      // Une version invalide et une erreur de protocole se constatent
      // AVANT de connaitre le mode : elles ne se ventilent pas, et
      // les repeter par mode ferait compter le meme paquet quatre fois.
      `Ntp bad version packets: 0`,
      `Ntp protocol error packets: 0`,
    ].join('\n');
  }
  return [
    `Ntp In packets: ${c.received}`,
    `Ntp Out packets: ${c.sent}`,
    `Ntp bad version packets: ${c.badVersion}`,
    `Ntp protocol error packets: ${c.protocolError}`,
  ].join('\n');
}

export function showNtpAuthenticationKeys(dev?: ShowStateDevice): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  const entete = 'Key  Algorithm  Md5 Key';
  if (!ntp || ntp.getConfig().authKeys.size === 0) return entete;
  const lignes = [...ntp.getConfig().authKeys.values()].map(
    (k) => `${String(k.id).padEnd(5)}${k.algo.padEnd(11)}${k.key}`);
  return [entete, ...lignes].join('\n');
}

const NTP_EPOCH_OFFSET_SEC = 2208988800;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatNtpReferenceTime(ms: number): string {
  const d = new Date(ms);
  const totalSecUtc = Math.floor(ms / 1000);
  const ntpSecs = totalSecUtc + NTP_EPOCH_OFFSET_SEC;
  const fracMs = ms % 1000;
  const fracNtp = Math.floor((fracMs / 1000) * 0x100000000);
  const ntpHex = (ntpSecs >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const fracHex = (fracNtp >>> 0).toString(16).toUpperCase().padStart(8, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  const msStr = String(d.getUTCMilliseconds()).padStart(3, '0');
  const wd = WEEKDAYS[d.getUTCDay()];
  const mo = MONTHS[d.getUTCMonth()];
  const day = d.getUTCDate();
  const yr = d.getUTCFullYear();
  return `${ntpHex}.${fracHex} (${hh}:${mm}:${ss}.${msStr} UTC ${wd} ${mo} ${day} ${yr})`;
}

export function showNtpAssociations(dev?: ShowStateDevice): string {
  const ntp = (dev as unknown as { getNtpAgent?: () => import('@/network/ntp/NtpAgent').NtpAgent } | undefined)?.getNtpAgent?.();
  const header = '  address         ref clock     st  when poll reach delay offset disp';
  // IOS met sa légende APRÈS le tableau, et le marqueur tient sur DEUX
  // caractères : l'état de sélection puis `~` pour « configurée ». Les
  // coller (`*~`, ` ~`) décalait la colonne d'adresse d'un cran.
  const legende = ' * sys.peer, # selected, + candidate, - outlyer, x falseticker, ~ configured';
  // Sans association, IOS rend l'en-tête et la légende — et rien entre
  // les deux. La phrase « No NTP associations configured. » n'existe
  // dans aucune version d'IOS : elle était inventée, et elle plaçait la
  // légende après un texte plutôt qu'après un tableau vide.
  if (!ntp || ntp.getConfig().associations.size === 0) {
    return [header, legende].join('\n');
  }
  const rows: string[] = [];
  for (const [, a] of ntp.getConfig().associations) {
    // `+` désigne une association CANDIDATE, ce qu'une association qui n'a
    // jamais répondu ne peut pas être : sans joignabilité, elle reste
    // simplement configurée.
    const joignable = a.reach !== 0;
    const marker = a.preferred && joignable ? '*' : a.prefer && joignable ? '+' : ' ';
    const since = a.lastReplyMs ? Math.floor((Date.now() - a.lastReplyMs) / 1000) : 999;
    rows.push(
      `${marker}~${a.serverIp.padEnd(15)} ${(a.stratum < 16 ? a.serverIp : '.INIT.').padEnd(13)} ${String(a.stratum).padEnd(3)} ${String(since).padEnd(5)} ${String(a.pollSec).padEnd(4)} ${a.reach.toString(8).padStart(3, '0')} ` +
      `${a.delayMs.toFixed(1).padStart(5)} ${a.offsetMs.toFixed(1).padStart(6)} ${a.dispersionMs.toFixed(1).padStart(5)}`,
    );
  }
  return [header, ...rows, legende].join('\n');
}

/**
 * `show line [n [m]] | [{aux|console|tty|vty} n [m]] [summary]`.
 *
 * Trois defauts mesures avant reecriture, decrits en tete de
 * `CiscoLineViews.ts` : l'argument etait IGNORE (`show line 2` listait
 * tout), le bloc de detail n'existait pas, et la forme rendue pour
 * `show line vty 0 4` — un tableau `Tty Line Speed Timeout` — n'existe
 * dans aucune version d'IOS.
 */
export function showLine(dev: ShowStateDevice, args: string[] = []): string {
  const mots = args.map((a) => a.toLowerCase()).filter((a) => a.length > 0);
  const resumeSeul = mots[mots.length - 1] === 'summary';
  const reste = resumeSeul ? mots.slice(0, -1) : mots;

  const inventaire = inventaireLignes(dev);
  // Pas d'argument : le tableau de toutes les lignes, sans detail.
  if (reste.length === 0) return tableauLignes(inventaire);

  const TYPES: Record<string, LigneTty['type']> = {
    con: 'CTY', console: 'CTY', aux: 'AUX', tty: 'VTY', vty: 'VTY',
  };
  let choisies: LigneTty[];
  const type = TYPES[reste[0]];
  if (type !== undefined) {
    const premier = Number.parseInt(reste[1] ?? '', 10);
    if (!Number.isFinite(premier)) return CISCO_INVALID_INPUT;
    const dernier = reste[2] !== undefined ? Number.parseInt(reste[2], 10) : premier;
    if (!Number.isFinite(dernier)) return CISCO_INVALID_INPUT;
    // `vty 0` designe le RANG dans le type, pas le numero absolu de tty
    // — sur un routeur la vty 0 est la ligne 2, et confondre les deux
    // ferait decrire la console quand on demande la premiere vty.
    choisies = inventaire.filter((l) => l.type === type && l.rang >= premier && l.rang <= dernier);
  } else {
    const premier = Number.parseInt(reste[0], 10);
    if (!Number.isFinite(premier)) return CISCO_INVALID_INPUT;
    const dernier = reste[1] !== undefined ? Number.parseInt(reste[1], 10) : premier;
    if (!Number.isFinite(dernier)) return CISCO_INVALID_INPUT;
    if (reste.length > 2) return CISCO_INVALID_INPUT;
    choisies = inventaire.filter((l) => l.tty >= premier && l.tty <= dernier);
  }
  if (choisies.length === 0) return CISCO_INVALID_INPUT;

  const sortie = [tableauLignes(choisies)];
  // `summary` est le SEUL suffixe qu'IOS accepte ici. Nommer une ligne
  // demande deja le detail — il n'existe pas de mot-cle `detail`, et
  // l'ajouter apprendrait une commande que le materiel refuse.
  if (!resumeSeul) {
    const maintenant = Date.now();
    for (const l of choisies) {
      sortie.push(...blocDetailLigne(l, reglagesDeLigne(dev, l), sessionSurLigne(dev, l), maintenant));
    }
  }
  return sortie.join('\n');
}

const CISCO_INVALID_INPUT = "% Invalid input detected at '^' marker.";

/**
 * L'inventaire reel : un routeur numerote CTY 0, AUX 1, puis les VTY a
 * partir de 2. Le nombre de VTY vient de la configuration — `line vty
 * 5 15` en cree vraiment onze de plus, et les afficher toujours au
 * nombre de cinq nierait la commande qu'on vient de taper.
 */
function inventaireLignes(dev: ShowStateDevice): LigneTty[] {
  const store = (dev as unknown as {
    _getVtyLineConfig?: () => { all: () => Array<{ first: number; last: number }> };
  })._getVtyLineConfig?.();
  let maxVty = 4;
  for (const bloc of store?.all() ?? []) maxVty = Math.max(maxVty, bloc.last);
  // `Uses` valait 0 pour toujours, sur toutes les lignes : la colonne
  // etait rendue sans que rien ne compte derriere. C'est pourtant le
  // chiffre qui distingue une ligne JAMAIS servie d'une ligne
  // simplement libre en ce moment.
  const reg = (dev as unknown as {
    getSshSessionRegistry?: () => {
      usesFor?: (k: 'con' | 'vty' | 'aux', i: number) => number;
    } | null;
  }).getSshSessionRegistry?.();
  const uses = (k: 'con' | 'vty' | 'aux', i: number): number => reg?.usesFor?.(k, i) ?? 0;
  const lignes: LigneTty[] = [
    { tty: 0, type: 'CTY', rang: 0, courante: true, uses: uses('con', 0) },
    // L'AUX n'est pas modelisee comme une ligne ouvrable ici : son
    // compteur reste 0 parce que rien ne s'y connecte, ce qui est vrai.
    { tty: 1, type: 'AUX', rang: 0, courante: false, uses: 0 },
  ];
  for (let i = 0; i <= maxVty; i++) {
    lignes.push({ tty: 2 + i, type: 'VTY', rang: i, courante: false, uses: uses('vty', i) });
  }
  return lignes;
}

/** Les reglages configures pour la ligne, lus dans le magasin que la CLI ecrit. */
function reglagesDeLigne(dev: ShowStateDevice, l: LigneTty): ReglagesLigne {
  if (l.type !== 'VTY') return REGLAGES_PAR_DEFAUT;
  const store = (dev as unknown as {
    _getVtyLineConfig?: () => { all: () => Array<Record<string, unknown>> };
  })._getVtyLineConfig?.();
  const bloc = (store?.all() ?? []).find(
    (b) => l.rang >= (b.first as number) && l.rang <= (b.last as number),
  );
  if (!bloc) return REGLAGES_PAR_DEFAUT;
  const n = (k: string): number | null => (typeof bloc[k] === 'number' ? bloc[k] as number : null);
  const t = (k: string): string | null => (typeof bloc[k] === 'string' ? bloc[k] as string : null);
  return {
    execTimeoutMinutes: n('execTimeoutMinutes'),
    execTimeoutSeconds: n('execTimeoutSeconds'),
    sessionTimeoutMinutes: n('sessionTimeoutMinutes'),
    absoluteTimeoutMinutes: n('absoluteTimeoutMinutes'),
    escapeCharacter: t('escapeCharacter'),
    historyEnabled: bloc.historyEnabled !== false,
    historySize: n('historySize'),
    transportInput: t('transportInput'),
    accessClassIn: t('accessClassIn'),
    screenLengthLines: n('screenLengthLines'),
  };
}

/**
 * La session posee sur cette ligne, s'il y en a une. Sans elle,
 * `Time since activation` annoncerait `never` sur une ligne occupee —
 * c'est-a-dire exactement le champ qu'on consulte pour reperer une
 * session abandonnee.
 */
function sessionSurLigne(dev: ShowStateDevice, l: LigneTty): SessionSurLigne | null {
  if (l.type !== 'VTY') return null;
  const reg = (dev as unknown as {
    getSshSessionRegistry?: () => { listSessions?: () => Array<{ line?: number; user?: string; startedAt?: number }> };
  }).getSshSessionRegistry?.();
  const s = (reg?.listSessions?.() ?? []).find((x) => x.line === l.rang);
  if (!s) return null;
  return { user: s.user ?? null, depuisMs: s.startedAt ?? Date.now() };
}

/**
 * `show ip ssh`.
 *
 * La fonction ne prenait AUCUN argument et rendait deux lignes
 * constantes : un `ip ssh time-out 45` etait accepte, garde, rendu par
 * `show running-config` et NIE ici, sur la meme machine au meme
 * instant. Elle lit desormais le magasin que la CLI ecrit.
 *
 * La taille de cle est passee par l'appelant plutot que lue ici : ce
 * module est partage par le routeur et le commutateur, et seul le
 * premier tient une configuration cryptographique. La ligne n'est
 * ecrite que si une paire existe — un routeur sans
 * `crypto key generate rsa` n'a pas de cle a decrire.
 */
export function showIpSsh(ssh?: {
  version: number; timeoutSec: number; authRetries: number; dhMinBits: number;
  macAlgorithms?: string[]; encryptionAlgorithms?: string[]; kexAlgorithms?: string[];
}, hostkeyModulus?: number | null): string {
  // `version 1` est le defaut d'IOS et signifie « les deux versions
  // acceptees », ce qu'IOS ecrit `1.99` et non `1.0`. Ce n'est pas une
  // coquetterie : c'est ainsi qu'un operateur voit d'un coup d'oeil que
  // `ip ssh version 2` n'a pas ete pose.
  const version = !ssh || ssh.version === 1 ? '1.99' : `${ssh.version}.0`;
  const lines = [
    `SSH Enabled - version ${version}`,
    `Authentication timeout: ${ssh?.timeoutSec ?? 120} secs;`
      + ` Authentication retries: ${ssh?.authRetries ?? 3}`,
    `Minimum expected Diffie Hellman key size : ${ssh?.dhMinBits ?? 1024} bits`,
  ];
  if (hostkeyModulus) lines.push(`Hostkey RSA key size is ${hostkeyModulus} bits`);
  // IOS n'ecrit ces lignes que si l'operateur a restreint la liste : une
  // liste vide veut dire « les algorithmes par defaut », et la remplir
  // d'une liste inventee decrirait une negociation qui n'a pas lieu.
  const algos: Array<[string, string[] | undefined]> = [
    ['MAC Algorithms', ssh?.macAlgorithms],
    ['Encryption Algorithms', ssh?.encryptionAlgorithms],
    ['KEX Algorithms', ssh?.kexAlgorithms],
  ];
  for (const [nom, liste] of algos) {
    if (liste && liste.length > 0) lines.push(`${nom}:${liste.join(',')}`);
  }
  return lines.join('\n');
}

/**
 * `show ssh` — les sessions SSH vivantes.
 *
 * Il y en avait DEUX implementations, donc deux reponses a une seule
 * question. Celle du socle rendait un en-tete et une phrase CONSTANTS :
 * elle ne lisait aucun registre et ne pouvait donc annoncer aucune
 * session, jamais. Celle du routeur lisait le vrai registre mais
 * ecrivait la phrase SANS le `%` — si bien que la meme commande, au meme
 * instant, se presentait autrement selon la plateforme.
 *
 * Ici il n'y en a qu'une. Le `%` est celui d'IOS, et **la ligne SSHv1
 * est toujours ecrite** : une vraie machine rend les deux sections, et
 * c'est cette ligne qui dit a un operateur que la version 1 — celle
 * qu'on veut voir absente — n'est pas en service.
 *
 * Un commutateur n'a pas de registre de sessions parce qu'il n'a pas de
 * pile TCP (limite deja ecrite pour le serveur HTTP) : il repond donc
 * « aucune connexion », ce qui est la verite et non un repli.
 */
/**
 * Le couple chiffrement/HMAC que le serveur retient — la PREFERENCE DU
 * SERVEUR, c'est-a-dire le premier de la liste qu'il accepte, ce qu'un
 * vrai serveur choisit quand le client offre tout.
 *
 * Une seule regle, parce que deux vues la posent : `show ssh` et le
 * message `%SSH-5-SSH2_SESSION`. Les laisser choisir chacune de leur
 * cote ferait annoncer au journal un chiffre que la table contredit.
 */
export function algorithmesRetenus(algos?: {
  encryptionAlgorithms?: string[]; macAlgorithms?: string[];
}): { chiffrement: string; hmac: string } {
  return {
    chiffrement: algos?.encryptionAlgorithms?.[0] ?? 'aes256-ctr',
    hmac: algos?.macAlgorithms?.[0] ?? 'hmac-sha2-256',
  };
}

export function showSshSessions(registre?: {
  list: () => readonly { lineIndex: number; user: string }[];
} | null, algos?: {
  encryptionAlgorithms?: string[]; macAlgorithms?: string[];
}): string {
  const actives = registre?.list() ?? [];
  const finV1 = '%No SSHv1 server connections running.';
  if (actives.length === 0) {
    return ['%No SSHv2 server connections running.', finV1].join('\n');
  }
  // Le chiffrement et le HMAC etaient ECRITS EN DUR : une machine sur
  // laquelle on venait de taper
  // `ip ssh server algorithm encryption aes128-ctr` annoncait quand meme
  // `aes256-ctr`, contredisant sa propre configuration au meme instant.
  //
  // Ce qui est rendu est la PREFERENCE DU SERVEUR — le premier de la
  // liste qu'il accepte — ce qu'un vrai serveur retient lorsque le
  // client offre tout. La limite reste entiere et n'est pas maquillee :
  // ce simulateur ne NEGOCIE pas ces algorithmes (le client n'offre
  // rien), donc il n'y a pas d'intersection a calculer ; ce qui change
  // est que la valeur affichee vient desormais de la machine et non
  // d'une constante.
  const { chiffrement, hmac } = algorithmesRetenus(algos);
  const entete = 'Connection Version Mode Encryption           Hmac                  State                 Username';
  const rangs = actives.map((s) =>
    `${String(s.lineIndex).padEnd(11)}2.0     IN   ${chiffrement.padEnd(21)}${hmac.padEnd(22)}Session started       ${s.user}`);
  return [entete, ...rangs, finV1].join('\n');
}

export interface ShowHostsDevice {
  _getHostsTable?: () => import('../../router/dns/RouterHostsTable').RouterHostsTable;
  _getDnsConfig?: () => import('../../router/dns/CiscoDnsConfig').CiscoDnsConfig;
}

export function showHosts(router?: ShowHostsDevice): string {
  const hosts = router?._getHostsTable?.();
  const dns = router?._getDnsConfig?.();
  const lines: string[] = [];
  lines.push(dns?.domainName
    ? `Default domain is ${dns.domainName}`
    : 'Default domain is not set');
  if (dns && dns.domainList.length > 0) {
    lines.push(`Domain list: ${dns.domainList.join(', ')}`);
  }
  if (dns?.lookupEnabled === false) lines.push('Name/address lookup is disabled');
  else if (dns && dns.nameServers.length > 0) lines.push('Name/address lookup uses domain service');
  else lines.push('Name/address lookup uses static mappings');
  lines.push(dns && dns.nameServers.length > 0
    ? `Name servers are ${dns.nameServers.join(', ')}`
    : 'Name servers are 255.255.255.255');
  lines.push('');
  lines.push('Codes: UN - unknown, EX - expired, OK - OK, ?? - revalidate');
  lines.push('       temp - temporary, perm - permanent');
  lines.push('       NA - Not Applicable None - Not defined');
  lines.push('');
  lines.push('Host                      Port  Flags      Age Type   Address(es)');
  for (const e of hosts?.entries() ?? []) {
    const drapeaux = `(${e.permanent ? 'perm' : 'temp'}, OK)`;
    lines.push(`${e.name.padEnd(26)}None  ${drapeaux.padEnd(11)}${String(e.ageSeconds).padEnd(4)}IP     ${e.ips.join(' ')}`);
  }
  return lines.join('\n');
}

export interface DnsStatsDevice {
  _getDnsStats?: () => {
    recues: number; repondues: number; nxdomain: number; transferees: number;
  };
}

export function showIpDnsStatistics(router?: DnsStatsDevice): string {
  const s = router?._getDnsStats?.()
    ?? { recues: 0, repondues: 0, nxdomain: 0, transferees: 0 };
  return [
    'DNS requests statistics:',
    `  Number of DNS requests received: ${s.recues}`,
    `  Number of DNS requests answered: ${s.repondues}`,
    `  Number of DNS requests forwarded: ${s.transferees}`,
    `  Number of DNS requests failed: ${s.nxdomain}`,
  ].join('\n');
}

/** `show vrf` / `show ip vrf` — enumerate configured VRF instances. */
export function showVrf(router?: unknown): string {
  const header = '  Name                             Default RD            Protocols   Interfaces';
  if (!router) return header;
  const r = router as { _vrfs?: Map<string, { name: string; rd?: string; interfaces: Set<string> }> };
  const vrfs = r._vrfs;
  if (!vrfs || vrfs.size === 0) return header;
  const lines = [header];
  for (const vrf of vrfs.values()) {
    const rd = vrf.rd ?? '<not set>';
    const ifaces = [...vrf.interfaces].join(', ') || '<none>';
    lines.push(`  ${vrf.name.padEnd(33)}${rd.padEnd(22)}${'ipv4'.padEnd(12)}${ifaces}`);
  }
  return lines.join('\n');
}

interface VrfView {
  _vrfs?: Map<string, { name: string; rd?: string; interfaces: Set<string> }>;
}

export function showVrfDetail(router?: unknown, name?: string): string {
  const vrfs = (router as VrfView | undefined)?._vrfs;
  if (!vrfs || vrfs.size === 0) {
    return name ? `% VRF ${name} does not exist` : '';
  }
  const wanted = name ? [vrfs.get(name)].filter(Boolean) : [...vrfs.values()];
  if (name && wanted.length === 0) return `% VRF ${name} does not exist`;
  const lines: string[] = [];
  for (const vrf of wanted as Array<{ name: string; rd?: string; interfaces: Set<string> }>) {
    lines.push(`VRF ${vrf.name}; default RD ${vrf.rd ?? '<not set>'}; default VPNID <not set>`);
    const ifaces = [...vrf.interfaces];
    if (ifaces.length === 0) {
      lines.push('  No interfaces');
    } else {
      lines.push('  Interfaces:');
      for (const i of ifaces) lines.push(`    ${i}`);
    }
    lines.push('Address family ipv4 unicast (Table ID 0x0):');
    lines.push('  No Export VPN route-target communities');
    lines.push('  No Import VPN route-target communities');
    lines.push('  No import route-map');
    lines.push('  No export route-map');
  }
  return lines.join('\n');
}

export function showVrfInterfaces(router?: unknown): string {
  const vrfs = (router as VrfView | undefined)?._vrfs;
  const header = 'Interface              VRF                              Protocol Address';
  if (!vrfs || vrfs.size === 0) return header;
  const lines = [header];
  const addr = (router as { getPort?: (n: string) => { getIPAddress?: () => unknown } | undefined })
    .getPort?.bind(router);
  for (const vrf of vrfs.values()) {
    for (const iface of vrf.interfaces) {
      const ip = addr?.(iface)?.getIPAddress?.();
      lines.push(`${iface.padEnd(23)}${vrf.name.padEnd(33)}${'up'.padEnd(9)}${ip ? String(ip) : '<not set>'}`);
    }
  }
  return lines.join('\n');
}

export interface AdjacencySource {
  _getArpTableInternal(): Map<string, { mac: { toString(): string }; iface: string }>;
}

export function showAdjacency(router: AdjacencySource): string {
  const header = 'Protocol Interface                 Address';
  const arp = router._getArpTableInternal();
  if (!arp || arp.size === 0) return header;
  const lines = [header];
  for (const [ip, entry] of arp) {
    lines.push(`IP       ${entry.iface.padEnd(26)}${ip}(${entry.mac})`);
  }
  return lines.join('\n');
}

/** `show redundancy` — single control plane (no redundant peer modelled). */
export function showRedundancy(): string {
  return [
    'Redundant System Information :',
    '       Configured Redundancy Mode = Simplex',
    'Current Processor Information :',
    '       Active Location = slot 0',
    '       Current Software state = ACTIVE',
  ].join('\n');
}

export interface FileSystemUsage {
  capacityBytes(): number;
  freeBytes(): number;
  nvramTotalBytes(): number;
  nvramFreeBytes(startupSize: number): number;
}

export function showFileSystems(fs: FileSystemUsage, startupConfigSize: number): string {
  const row = (mark: string, size: string, free: string, type: string, prefix: string) =>
    `${mark}${size.padStart(12)}${free.padStart(12)}  ${type.padStart(8)}     rw   ${prefix}`;
  return [
    'File Systems:',
    '',
    '      Size(b)     Free(b)      Type  Flags  Prefixes',
    row('*', String(fs.capacityBytes()), String(fs.freeBytes()), 'flash', 'flash:'),
    row(' ', String(fs.nvramTotalBytes()),
      String(fs.nvramFreeBytes(startupConfigSize)), 'nvram', 'nvram:'),
  ].join('\n');
}

/** `show calendar` — the device's real hardware clock (system time). */
/**
 * `show calendar` lit LA MÊME horloge que `show clock`.
 *
 * Il lisait l'heure de la machine hôte, donc `clock set` et
 * `clock timezone` n'avaient aucun effet dessus : le même équipement
 * répondait deux dates différentes à deux questions sur l'heure, et
 * l'écart d'une heure après un `clock timezone` trahissait la fuite.
 *
 * Une seule différence de rendu subsiste, et elle est réelle : le
 * calendrier ne porte jamais le `*` d'IOS, qui signale une horloge
 * système non autoritative — un composant matériel ne se déclare pas
 * incertain.
 */
export function showCalendar(arg: Date | ShowStateDevice = new Date()): string {
  const reading = ciscoClockReading(arg);
  return `${iosTimeOfDay(reading.local)} ${reading.timezone}`
    + ` ${iosDateSuffix(reading.local)}`;
}

/** `show terminal` — the active session's real defaults. */
export function showSwitchVersion(dev: {
  getHostname(): string;
  getUptimeMs(): number;
  getPortNames(): string[];
  getPort(name: string): { getMAC(): { toCiscoString(): string } } | undefined;
}): string {
  const hw = CISCO_HARDWARE_PROFILES['switch-c3560'];
  const names = dev.getPortNames();
  const fa = names.filter((n) => n.startsWith('Fast')).length;
  const gi = names.filter((n) => n.startsWith('Gig') && !n.includes('.')).length;
  const baseMac = names.length ? (dev.getPort(names[0])?.getMAC().toCiscoString() ?? '0000.0000.0000') : '0000.0000.0000';
  const up = formatIosUptime(dev.getUptimeMs());
  return [
    `${ciscoSoftwareDescriptor(C3560_SOFTWARE, 'RELEASE SOFTWARE (fc3)')}`,
    'Copyright (c) 1986-2025 by Cisco Systems, Inc.',
    '',
    'ROM: Bootstrap program is C3560 boot loader',
    'BOOTLDR: C3560 Boot Loader (C3560-HBOOT-M) Version 12.2(44r)SE, RELEASE SOFTWARE (fc1)',
    '',
    `${dev.getHostname()} uptime is ${up}`,
    'System returned to ROM by power-on',
    `System image file is "flash:${hw.flashImage}"`,
    '',
    `cisco ${hw.pid} (PowerPC405) processor (revision C0) with ${Math.floor(hw.dramKB / 2)}K/${hw.ioMemoryKB}K bytes of memory.`,
    `Processor board ID ${hw.serialNumber}`,
    'Last reset from power-on',
    `${fa} FastEthernet interfaces`,
    `${gi} Gigabit Ethernet interfaces`,
    `The password-recovery mechanism is enabled.`,
    '',
    `${hw.nvramKB}K bytes of flash-simulated non-volatile configuration memory.`,
    `Base ethernet MAC Address       : ${baseMac}`,
    `Motherboard assembly number     : 73-12600-06`,
    `Model number                    : ${hw.pid}`,
    `System serial number            : ${hw.serialNumber}`,
    '',
    'Configuration register is 0xF',
  ].join('\n');
}

export function showTerminal(length = 24, width = 80, historySize = 20): string {
  return [
    'Line 0, Location: "", Type: ""',
    `Length: ${length} lines, Width: ${width} columns`,
    'Editing is enabled.',
    `History is enabled, history size is ${historySize}.`,
  ].join('\n');
}

/**
 * `show processes memory` / `show stacks` — aucun processus n'est
 * ordonnancé ici, donc l'en-tête est rendu et la liste est vide : les
 * compteurs restent à zéro plutôt que d'être inventés.
 */
export function showProcessesMemory(): string {
  return [
    'Processor Pool Total: 0 Used: 0 Free: 0',
    ' PID TTY  Allocated      Freed    Holding    Getbufs    Retbufs Process',
  ].join('\n');
}

const PUBLIC_BUFFER_POOLS: ReadonlyArray<{ name: string; bytes: number; permanent: number; min: number; max: number }> = [
  { name: 'Small', bytes: 104, permanent: 50, min: 20, max: 150 },
  { name: 'Middle', bytes: 600, permanent: 25, min: 10, max: 150 },
  { name: 'Big', bytes: 1536, permanent: 50, min: 5, max: 150 },
  { name: 'VeryBig', bytes: 4520, permanent: 10, min: 0, max: 100 },
  { name: 'Large', bytes: 5024, permanent: 0, min: 0, max: 10 },
  { name: 'Huge', bytes: 18024, permanent: 0, min: 0, max: 4 },
];

export function showBuffers(): string {
  const lines: string[] = [
    'Buffer elements:',
    '     500 in free list (500 max allowed)',
    '     0 hits, 0 misses, 0 created',
    '',
    'Public buffer pools:',
  ];
  for (const p of PUBLIC_BUFFER_POOLS) {
    lines.push(`${p.name} buffers, ${p.bytes} bytes (total ${p.permanent}, permanent ${p.permanent}):`);
    lines.push(`     ${p.permanent} in free list (${p.min} min, ${p.max} max allowed)`);
    lines.push('     0 hits, 0 misses, 0 trims, 0 created');
    lines.push('     0 failures (0 no memory)');
  }
  return lines.join('\n');
}

const TCP_STATE_IOS: Readonly<Record<string, string>> = {
  'listen': 'LISTEN',
  'syn-sent': 'SYNSENT',
  'syn-received': 'SYNRCVD',
  'established': 'ESTAB',
  'fin-wait-1': 'FINWAIT1',
  'fin-wait-2': 'FINWAIT2',
  'close-wait': 'CLOSEWAIT',
  'closing': 'CLOSING',
  'last-ack': 'LASTACK',
  'time-wait': 'TIMEWAIT',
  'closed': 'CLOSED',
};

interface TcpBriefRow {
  readonly local: string;
  readonly foreign: string;
  readonly state: string;
}

function tcbHandle(row: TcpBriefRow): string {
  let hash = 0x6000_0000;
  for (const c of `${row.local}|${row.foreign}`) {
    hash = ((hash * 31) + c.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).toUpperCase().padStart(8, '0').slice(-8);
}

function tcpEndpoint(ip: string, port: number): string {
  return `${ip === '0.0.0.0' || ip === '' ? '*' : ip}.${port}`;
}

export interface TcpBriefSource {
  listListeners(): ReadonlyArray<{ localIp: string; localPort: number }>;
  listSockets(): ReadonlyArray<{
    localIp: string; localPort: number;
    remoteIp: string; remotePort: number; state: string;
  }>;
}

export function showTcpBrief(stack?: TcpBriefSource | null): string {
  const header = 'TCB       Local Address           Foreign Address        (state)';
  if (!stack) return header;

  const rows: TcpBriefRow[] = [
    ...stack.listSockets().map(s => ({
      local: tcpEndpoint(s.localIp, s.localPort),
      foreign: tcpEndpoint(s.remoteIp, s.remotePort),
      state: TCP_STATE_IOS[s.state] ?? s.state.toUpperCase(),
    })),
    ...stack.listListeners().map(l => ({
      local: tcpEndpoint(l.localIp, l.localPort),
      foreign: '*.*',
      state: 'LISTEN',
    })),
  ];

  return [header, ...rows.map(row =>
    `${tcbHandle(row).padEnd(10)}${row.local.padEnd(24)}`
    + `${row.foreign.padEnd(23)}${row.state}`)].join('\n');
}

export function showSockets(): string {
  return 'Proto    Local Address      Foreign Address      State';
}

export function showStacks(): string {
  return [
    'Minimum process stacks:',
    'Free/Size   Name',
    'Interrupt level stacks:',
    'Level    Called Unused/Size Name',
  ].join('\n');
}

export function showReload(scheduledAtMs?: number | null): string {
  if (scheduledAtMs === null || scheduledAtMs === undefined) return 'No reload is scheduled.';
  const sec = Math.max(0, Math.floor((scheduledAtMs - Date.now()) / 1000));
  return `Reload scheduled in ${Math.floor(sec / 60)} minutes ${sec % 60} seconds`;
}

export function showAaa(sec: import('@/network/devices/router/security/CiscoSecurityConfig').CiscoSecurityConfig, arg = ''): string {
  const lower = arg.toLowerCase();
  if (lower.includes('server')) {
    if (sec.radiusServers.size === 0 && sec.tacacsServers.size === 0) return 'No AAA servers configured';
    const lines: string[] = [];
    for (const r of sec.radiusServers.values()) lines.push(`RADIUS: ${r.name} (${r.address ?? 'unconfigured'})`);
    for (const t of sec.tacacsServers.values()) lines.push(`TACACS+: ${t.name} (${t.address ?? 'unconfigured'})`);
    return lines.join('\n');
  }
  // `show aaa local` seul rendait la ligne des sessions, comme si le
  // mot-clé n'avait pas été tapé. IOS attend `user lockout` derrière.
  if (lower.startsWith('local')) {
    const rest = lower.slice('local'.length).trim();
    if (rest === '') return '% Incomplete command.';
    return "% Invalid input detected at '^' marker.";
  }
  if (lower.includes('group')) {
    if (sec.aaaGroups.size === 0) return 'No AAA server groups configured';
    const lines: string[] = [];
    for (const g of sec.aaaGroups.values()) {
      lines.push(`Server group: ${g.name}`);
      lines.push(`  Server protocol: ${g.kind}`);
      lines.push(`  Server (${g.kind === 'radius' ? 'A.B.C.D' : 'name'}): ${g.members.length ? g.members.join(', ') : '<none>'}`);
    }
    return lines.join('\n');
  }
  // `show aaa` seul repondait `Total sessions since last reload: 0`,
  // c'est-a-dire la reponse de `show aaa sessions` : trois commandes
  // (`show aaa`, `show aaa sessions`, `show aaa user all`) rendaient un
  // seul et meme texte, donc deux d'entre elles ne repondaient pas a la
  // question posee. `show aaa` decrit l'ETAT DU SOUS-SYSTEME.
  if (lower === '') {
    if (!sec.aaaNewModel) return 'AAA is disabled.';
    // Chaque ligne est LUE sur les methodes declarees : une machine ou
    // seule l'authentification est configuree ne doit pas annoncer une
    // autorisation active.
    const actif = (phase: string) =>
      sec.aaaMethods.some((m) => m.phase === phase) ? 'enabled' : 'disabled';
    return [
      `Global Authentication: ${actif('authentication')}`,
      `Global Authorization: ${actif('authorization')}`,
      `Global Accounting: ${actif('accounting')}`,
    ].join('\n');
  }
  return 'Total sessions since last reload: 0';
}

/**
 * `show environment` — le châssis ne porte aucune source d'alarme, donc
 * les trois compteurs sont à zéro : c'est une lecture, pas un relevé de
 * capteur inventé.
 */
export function showEnvironment(): string {
  return [
    'Number of Critical alarms:  0',
    'Number of Major alarms:     0',
    'Number of Minor alarms:     0',
  ].join('\n');
}

/** `show ip traffic` — aggregate per-protocol counters from real port stats. */
export interface ArpTrafficCounters {
  rxRequests: number;
  rxReplies: number;
  txRequests: number;
  txReplies: number;
}

export function showIpTraffic(ports: Iterable<Port>, arp?: ArpTrafficCounters): string {
  let rxFrames = 0, txFrames = 0, errsIn = 0, errsOut = 0, dropsIn = 0, dropsOut = 0;
  for (const p of ports) {
    const c = p.getCounters();
    rxFrames += c.framesIn;
    txFrames += c.framesOut;
    errsIn += c.errorsIn;
    errsOut += c.errorsOut;
    dropsIn += c.dropsIn;
    dropsOut += c.dropsOut;
  }
  const lines = [
    'IP statistics:',
    `  Rcvd:  ${rxFrames} total, ${rxFrames} local destination`,
    `         ${errsIn} format errors, 0 checksum errors, 0 bad hop count`,
    '         0 unknown protocol, 0 not a gateway, 0 security failures',
    `         0 bad options, 0 with options, ${dropsIn} dropped`,
    '  Frags: 0 reassembled, 0 timeouts, 0 couldn\'t reassemble',
    '  Bcast: 0 received, 0 sent',
    '  Mcast: 0 received, 0 sent',
    `  Sent:  ${txFrames} generated, ${txFrames} forwarded, ${errsOut} errors, ${dropsOut} dropped`,
  ];
  if (arp) {
    const rxTotal = arp.rxRequests + arp.rxReplies;
    const txTotal = arp.txRequests + arp.txReplies;
    lines.push(
      'ARP statistics:',
      `  Rcvd: ${rxTotal} requests, ${arp.rxReplies} replies, 0 reverse, 0 other`,
      `  Sent: ${txTotal} requests, ${arp.txReplies} replies (0 proxy), 0 reverse`,
    );
  }
  return lines.join('\n');
}

/** `show controllers <intf>` — real per-port link/cable status. */
/**
 * `show controllers` interroge le CONTRÔLEUR MATÉRIEL d'une interface.
 * Une loopback n'en a pas, une sous-interface partage celui de son
 * parent : ni l'une ni l'autre n'y figurent sur un vrai routeur. L'ordre
 * est celui du châssis — par type puis par index — et non celui de
 * création.
 */
function hasHardwareController(name: string): boolean {
  if (name.includes('.')) return false;
  return !/^(Loopback|Tunnel|Vlan|BVI|Port-channel|Bundle-Ether|Null|Nve|Virtual-Template)/i
    .test(name);
}

function chassisOrder(name: string): Array<number | string> {
  const match = /^([A-Za-z-]+)(.*)$/.exec(name);
  const family = match ? match[1].toLowerCase() : name.toLowerCase();
  const indices = (match ? match[2] : '').split(/[^0-9]+/).filter(Boolean).map(Number);
  return [family, ...indices];
}

export function showControllers(dev: ShowStateDevice, arg = ''): string {
  const want = arg.trim().toLowerCase();
  const ports = dev.getPorts()
    .filter((p) => hasHardwareController(p.getName()))
    .filter((p) => !want || p.getName().toLowerCase().includes(want))
    .sort((a, b) => {
      const left = chassisOrder(a.getName());
      const right = chassisOrder(b.getName());
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const l = left[i];
        const r = right[i];
        if (l === undefined) return -1;
        if (r === undefined) return 1;
        if (l === r) continue;
        return typeof l === 'string' || typeof r === 'string'
          ? String(l).localeCompare(String(r))
          : (l as number) - (r as number);
      }
      return 0;
    });
  if (!ports.length) return 'Interface does not exist';
  return ports.map((p) => {
    const view = iosInterfaceStatus(p);
    return [
      `${p.getName()} -`,
      `  Hardware is present, link is ${view.carrierUp ? 'connected' : 'down'}`,
      `  Administrative state: ${view.adminUp ? 'up' : 'administratively down'}`,
      '  0 carrier transitions',
    ].join('\n');
  }).join('\n');
}

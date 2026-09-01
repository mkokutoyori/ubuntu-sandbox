import type { DeviceType, IPAddress } from '../core/types';
import type { NetworkPdu } from '@/network/core/NetworkPdu';

export const ETHERTYPE_LLDP = 0x88cc;
export const LLDP_MULTICAST_MAC = '01:80:c2:00:00:0e';

export type LldpCapability = 'Router' | 'Bridge' | 'Telephone' | 'Repeater' | 'Station' | 'Other';

export const LLDP_CHASSIS_ID_SUBTYPE = {
  chassisComponent: 1, interfaceAlias: 2, portComponent: 3,
  macAddress: 4, networkAddress: 5, interfaceName: 6, local: 7,
} as const;

export const LLDP_PORT_ID_SUBTYPE = {
  interfaceAlias: 1, portComponent: 2, macAddress: 3, networkAddress: 4,
  interfaceName: 5, agentCircuitId: 6, local: 7,
} as const;

export type LldpChassisIdSubtype = keyof typeof LLDP_CHASSIS_ID_SUBTYPE;
export type LldpPortIdSubtype = keyof typeof LLDP_PORT_ID_SUBTYPE;

export interface LldpFrame extends NetworkPdu {
  type: 'lldp';
  chassisId: string;
  chassisIdSubtype: LldpChassisIdSubtype;
  portId: string;
  portIdSubtype: LldpPortIdSubtype;
  ttlSec: number;
  portDescription?: string;
  systemName?: string;
  systemDescription?: string;
  capabilities?: LldpCapability[];
  managementAddresses?: string[];
}

export interface LldpNeighborEntry {
  localPort: string;
  chassisId: string;
  chassisIdSubtype: LldpChassisIdSubtype;
  portId: string;
  portIdSubtype: LldpPortIdSubtype;
  systemName?: string;
  systemDescription?: string;
  portDescription?: string;
  remoteType: DeviceType;
  remoteCapabilities?: LldpCapability[];
  managementAddresses?: string[];
  learnedAtMs: number;
  ttlSec: number;
  expiresAtMs: number;
}

export const LLDP_CAPABILITY_BIT: Readonly<Record<LldpCapability, number>> = {
  Other: 0x01,
  Repeater: 0x02,
  Bridge: 0x04,
  Router: 0x10,
  Telephone: 0x20,
  Station: 0x80,
};

const LLDP_CAPABILITY_LETTER: Readonly<Record<LldpCapability, string>> = {
  Other: 'O',
  Repeater: 'P',
  Bridge: 'B',
  Router: 'R',
  Telephone: 'T',
  Station: 'S',
};

const LLDP_CAPABILITY_WORD: Readonly<Record<LldpCapability, string>> = {
  Other: 'other',
  Repeater: 'repeater',
  Bridge: 'bridge',
  Router: 'router',
  Telephone: 'telephone',
  Station: 'stationOnly',
};

function inBitOrder(caps: readonly LldpCapability[]): LldpCapability[] {
  const seen = new Set(caps);
  return (Object.keys(LLDP_CAPABILITY_BIT) as LldpCapability[])
    .filter(c => seen.has(c))
    .sort((a, b) => LLDP_CAPABILITY_BIT[a] - LLDP_CAPABILITY_BIT[b]);
}

export function lldpCapabilityLetters(caps: readonly LldpCapability[]): string {
  return inBitOrder(caps).map(c => LLDP_CAPABILITY_LETTER[c]).join(',');
}

export function lldpCapabilityWords(caps: readonly LldpCapability[]): string {
  return inBitOrder(caps).map(c => LLDP_CAPABILITY_WORD[c]).join(' ');
}

const SYSTEMD_CAPABILITY_MASK: ReadonlyArray<readonly [string, string]> = [
  ['o', 'Other'], ['p', 'Repeater'], ['b', 'Bridge'], ['w', 'WLAN Access Point'],
  ['r', 'Router'], ['t', 'Telephone'], ['d', 'DOCSIS cable device'], ['a', 'Station'],
  ['c', 'Customer VLAN'], ['s', 'Service VLAN'], ['m', 'Two-port MAC Relay (TPMR)'],
];

const SYSTEMD_LETTER_FOR: Readonly<Record<LldpCapability, string>> = {
  Other: 'o', Repeater: 'p', Bridge: 'b', Router: 'r', Telephone: 't', Station: 'a',
};

export function lldpCapabilityMask(caps: readonly LldpCapability[]): string {
  const set = new Set(caps.map(c => SYSTEMD_LETTER_FOR[c]));
  return SYSTEMD_CAPABILITY_MASK.map(([l]) => (set.has(l) ? l : '.')).join('');
}

export function lldpCapabilityLegend(caps: readonly LldpCapability[]): string[] {
  const set = new Set(caps.map(c => SYSTEMD_LETTER_FOR[c]));
  return SYSTEMD_CAPABILITY_MASK
    .filter(([l]) => set.has(l))
    .map(([l, name]) => `${l} - ${name}`);
}

export const LLDP_OPTIONAL_TLVS = [
  'port-description', 'system-name', 'system-description',
  'system-capabilities', 'management-address',
] as const;

export type LldpOptionalTlv = typeof LLDP_OPTIONAL_TLVS[number];

export interface LldpPortConfig {
  transmit: boolean;
  receive: boolean;
  suppressedTlvs: Set<LldpOptionalTlv>;
}

export interface LldpConfig {
  enabled: boolean;
  timerSec: number;
  holdtimeMultiplier: number;
  reinitDelaySec: number;
  ports: Map<string, LldpPortConfig>;
}

export function createDefaultLldpConfig(): LldpConfig {
  return {
    enabled: false,
    timerSec: 30,
    holdtimeMultiplier: 4,
    reinitDelaySec: 2,
    ports: new Map(),
  };
}

export function neighborKey(localPort: string, chassisId: string, portId: string): string {
  return `${localPort}|${chassisId}|${portId}`;
}

export function defaultPortConfig(): LldpPortConfig {
  return { transmit: true, receive: true, suppressedTlvs: new Set() };
}

export type { IPAddress };

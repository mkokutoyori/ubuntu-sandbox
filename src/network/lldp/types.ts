import type { DeviceType, IPAddress } from '../core/types';
import type { NetworkPdu } from '@/network/core/NetworkPdu';

export const ETHERTYPE_LLDP = 0x88cc;
export const LLDP_MULTICAST_MAC = '01:80:c2:00:00:0e';

export type LldpCapability = 'Router' | 'Bridge' | 'Telephone' | 'Repeater' | 'Station' | 'Other';

export interface LldpFrame extends NetworkPdu {
  type: 'lldp';
  chassisId: string;
  portId: string;
  ttlSec: number;
  portDescription: string;
  systemName: string;
  systemDescription: string;
  capabilities: LldpCapability[];
  managementAddresses: string[];
}

export interface LldpNeighborEntry {
  localPort: string;
  chassisId: string;
  portId: string;
  systemName: string;
  systemDescription: string;
  portDescription: string;
  remoteType: DeviceType;
  remoteCapabilities: LldpCapability[];
  managementAddresses: string[];
  learnedAtMs: number;
  ttlSec: number;
  expiresAtMs: number;
}

export interface LldpPortConfig {
  transmit: boolean;
  receive: boolean;
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
  return { transmit: true, receive: true };
}

export type { IPAddress };

import type { LldpCapability } from './types';

export interface LldpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface LldpFrameSentPayload extends LldpDeviceRef {
  port: string;
  reason: 'link-up' | 'periodic' | 'config-change';
}

export interface LldpFrameReceivedPayload extends LldpDeviceRef {
  port: string;
  remoteSystem: string;
  remotePort: string;
}

export interface LldpNeighborDiscoveredPayload extends LldpDeviceRef {
  localPort: string;
  remoteSystem: string;
  remotePort: string;
  remoteCapabilities: LldpCapability[];
  ttlSec: number;
}

export interface LldpNeighborRefreshedPayload extends LldpDeviceRef {
  localPort: string;
  remoteSystem: string;
}

export interface LldpNeighborExpiredPayload extends LldpDeviceRef {
  localPort: string;
  remoteSystem: string;
  cause: 'ttl' | 'link-down' | 'admin-disabled';
}

export interface LldpConfigChangedPayload extends LldpDeviceRef {
  enabled: boolean;
  timerSec: number;
  holdtimeMultiplier: number;
}

export type LldpDomainEvent =
  | { topic: 'lldp.frame.sent'; payload: LldpFrameSentPayload }
  | { topic: 'lldp.frame.received'; payload: LldpFrameReceivedPayload }
  | { topic: 'lldp.neighbor.discovered'; payload: LldpNeighborDiscoveredPayload }
  | { topic: 'lldp.neighbor.refreshed'; payload: LldpNeighborRefreshedPayload }
  | { topic: 'lldp.neighbor.expired'; payload: LldpNeighborExpiredPayload }
  | { topic: 'lldp.config.changed'; payload: LldpConfigChangedPayload };

/**
 * CDP — reactive event taxonomy.
 *
 * Consumers (in the codebase today):
 *   - `Logger` mirrors every topic for the trace timeline.
 *   - The hosting Cisco device's `show cdp` reads the neighbour table
 *     that the agent maintains in response to receive events.
 *   - Tests subscribe to `cdp.neighbor.discovered` / `cdp.neighbor.expired`
 *     to assert protocol-driven topology discovery without polling.
 */
import type { CdpCapability } from './types';

export interface CdpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface CdpFrameSentPayload extends CdpDeviceRef {
  port: string;
  reason: 'link-up' | 'periodic' | 'config-change';
}

export interface CdpFrameReceivedPayload extends CdpDeviceRef {
  port: string;
  remoteHost: string;
  remotePort: string;
}

export interface CdpNeighborDiscoveredPayload extends CdpDeviceRef {
  localPort: string;
  remoteHost: string;
  remotePort: string;
  remoteCapability: CdpCapability;
  holdtimeSec: number;
}

export interface CdpNeighborRefreshedPayload extends CdpDeviceRef {
  localPort: string;
  remoteHost: string;
}

export interface CdpNeighborExpiredPayload extends CdpDeviceRef {
  localPort: string;
  remoteHost: string;
  cause: 'holdtime' | 'link-down' | 'admin-disabled';
}

export interface CdpConfigChangedPayload extends CdpDeviceRef {
  enabled: boolean;
  timerSec: number;
  holdtimeSec: number;
}

export type CdpDomainEvent =
  | { topic: 'cdp.frame.sent';            payload: CdpFrameSentPayload }
  | { topic: 'cdp.frame.received';        payload: CdpFrameReceivedPayload }
  | { topic: 'cdp.neighbor.discovered';   payload: CdpNeighborDiscoveredPayload }
  | { topic: 'cdp.neighbor.refreshed';    payload: CdpNeighborRefreshedPayload }
  | { topic: 'cdp.neighbor.expired';      payload: CdpNeighborExpiredPayload }
  | { topic: 'cdp.config.changed';        payload: CdpConfigChangedPayload };

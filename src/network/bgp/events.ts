import type { BgpErrorCode } from './messages';

export interface BgpNeighborStateChangedPayload {
  deviceId: string;
  neighborIp: string;
  oldState: string;
  newState: string;
  remoteAs: number | null;
  lastError: BgpErrorCode;
}

export type BgpDomainEvent =
  | { topic: 'bgp.neighbor.state-changed'; payload: BgpNeighborStateChangedPayload };

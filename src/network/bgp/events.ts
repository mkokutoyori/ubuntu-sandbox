import type { BgpErrorCode } from './messages';

export interface BgpNeighborStateChangedPayload {
  deviceId: string;
  neighborIp: string;
  oldState: string;
  newState: string;
  remoteAs: number | null;
  lastError: BgpErrorCode;
}

export interface BgpUpdateTracedPayload {
  deviceId: string;
  neighborIp: string;
  announced: readonly string[];
  withdrawn: readonly string[];
  origin: string | null;
  asPath: readonly number[];
  nextHop: string | null;
  med: number | null;
  localPref: number | null;
}

export type BgpDomainEvent =
  | { topic: 'bgp.neighbor.state-changed'; payload: BgpNeighborStateChangedPayload }
  | { topic: 'bgp.update.sent'; payload: BgpUpdateTracedPayload }
  | { topic: 'bgp.update.received'; payload: BgpUpdateTracedPayload };

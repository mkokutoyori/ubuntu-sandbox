export interface BgpNeighborStateChangedPayload {
  deviceId: string;
  neighborIp: string;
  oldState: string;
  newState: string;
  remoteAs: number | null;
}

export type BgpDomainEvent =
  | { topic: 'bgp.neighbor.state-changed'; payload: BgpNeighborStateChangedPayload };

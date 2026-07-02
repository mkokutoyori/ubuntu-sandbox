export interface EigrpNeighborStateChangedPayload {
  deviceId: string;
  neighbor: string;
  iface: string;
  oldState: string;
  newState: string;
  asn: number;
}

export interface EigrpKValueMismatchPayload {
  deviceId: string;
  neighbor: string;
  neighborIp: string;
  iface: string;
  asn: number;
  localK: Record<string, number>;
  peerK: Record<string, number>;
}

export type EigrpDomainEvent =
  | { topic: 'eigrp.neighbor.state-changed'; payload: EigrpNeighborStateChangedPayload }
  | { topic: 'eigrp.neighbor.k-value-mismatch'; payload: EigrpKValueMismatchPayload };

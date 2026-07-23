export interface NhrpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface NhrpPacketSentPayload extends NhrpDeviceRef {
  ifName: string;
  opcode: import('./types').NhrpOpcode;
  destNbmaAddr: string;
}

export interface NhrpPacketReceivedPayload extends NhrpDeviceRef {
  ifName: string;
  opcode: import('./types').NhrpOpcode;
  srcNbmaAddr: string;
}

export interface NhrpCacheUpdatedPayload extends NhrpDeviceRef {
  ifName: string;
  targetAddress: string;
  nbmaAddress: string;
  type: 'dynamic';
}

export interface NhrpPacketDroppedPayload extends NhrpDeviceRef {
  ifName: string;
  opcode: import('./types').NhrpOpcode;
  reason: 'authentication-failure' | 'no-binding';
}

export type NhrpDomainEvent =
  | { topic: 'nhrp.packet.sent'; payload: NhrpPacketSentPayload }
  | { topic: 'nhrp.packet.received'; payload: NhrpPacketReceivedPayload }
  | { topic: 'nhrp.cache.updated'; payload: NhrpCacheUpdatedPayload }
  | { topic: 'nhrp.packet.dropped'; payload: NhrpPacketDroppedPayload };

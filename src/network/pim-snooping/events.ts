export interface PimSnoopingDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface PimSnoopingNeighborChangedPayload extends PimSnoopingDeviceRef {
  vlan: number;
  port: string;
  neighborIp: string;
  added: boolean;
}

export interface PimSnoopingMemberJoinedPayload extends PimSnoopingDeviceRef {
  vlan: number;
  groupAddress: string;
  port: string;
  neighborIp: string;
}

export interface PimSnoopingMemberLeftPayload extends PimSnoopingDeviceRef {
  vlan: number;
  groupAddress: string;
  port: string;
  reason: 'prune' | 'timeout' | 'config' | 'link';
}

export type PimSnoopingDomainEvent =
  | { topic: 'pim.snooping.neighbor.changed'; payload: PimSnoopingNeighborChangedPayload }
  | { topic: 'pim.snooping.member.joined'; payload: PimSnoopingMemberJoinedPayload }
  | { topic: 'pim.snooping.member.left'; payload: PimSnoopingMemberLeftPayload };

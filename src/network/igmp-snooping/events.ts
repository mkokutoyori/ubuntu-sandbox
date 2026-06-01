export interface SnoopingDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface SnoopingMemberJoinedPayload extends SnoopingDeviceRef {
  vlan: number;
  groupAddress: string;
  port: string;
  reporterIp: string;
}

export interface SnoopingMemberLeftPayload extends SnoopingDeviceRef {
  vlan: number;
  groupAddress: string;
  port: string;
  reason: 'leave' | 'timeout' | 'config' | 'link';
}

export interface SnoopingRouterPortChangedPayload extends SnoopingDeviceRef {
  vlan: number;
  port: string;
  added: boolean;
}

export interface SnoopingForwardPayload extends SnoopingDeviceRef {
  vlan: number;
  groupAddress: string;
  ingressPort: string;
  egressPorts: string[];
}

export type IgmpSnoopingDomainEvent =
  | { topic: 'igmp.snooping.member.joined'; payload: SnoopingMemberJoinedPayload }
  | { topic: 'igmp.snooping.member.left'; payload: SnoopingMemberLeftPayload }
  | { topic: 'igmp.snooping.router-port.changed'; payload: SnoopingRouterPortChangedPayload }
  | { topic: 'igmp.snooping.forward'; payload: SnoopingForwardPayload };

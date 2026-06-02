export interface VxlanDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface VxlanPacketEncapsulatedPayload extends VxlanDeviceRef {
  vni: number;
  innerSrcMac: string;
  innerDstMac: string;
  remoteVtepIp: string;
}

export interface VxlanPacketDecapsulatedPayload extends VxlanDeviceRef {
  vni: number;
  innerSrcMac: string;
  innerDstMac: string;
  remoteVtepIp: string;
}

export interface VxlanPacketDroppedPayload extends VxlanDeviceRef {
  vni: number | null;
  remoteVtepIp: string | null;
  reason: 'no-vtep' | 'no-vni' | 'no-source-ip' | 'no-egress' | 'disabled' | 'invalid-vni' | 'invalid-frame';
}

export interface VxlanMacLearnedPayload extends VxlanDeviceRef {
  vni: number;
  mac: string;
  remoteVtepIp: string;
}

export interface VxlanVtepChangedPayload extends VxlanDeviceRef {
  vni: number;
  remoteVtepIp: string;
  added: boolean;
}

export type VxlanDomainEvent =
  | { topic: 'vxlan.packet.encapsulated'; payload: VxlanPacketEncapsulatedPayload }
  | { topic: 'vxlan.packet.decapsulated'; payload: VxlanPacketDecapsulatedPayload }
  | { topic: 'vxlan.packet.dropped'; payload: VxlanPacketDroppedPayload }
  | { topic: 'vxlan.mac.learned'; payload: VxlanMacLearnedPayload }
  | { topic: 'vxlan.vtep.changed'; payload: VxlanVtepChangedPayload };

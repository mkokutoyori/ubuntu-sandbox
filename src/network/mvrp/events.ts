export interface MvrpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface MvrpVlanRegistrationPayload extends MvrpDeviceRef {
  port: string;
  vid: number;
  isNew: boolean;
}

export interface MvrpVlanDeregistrationPayload extends MvrpDeviceRef {
  port: string;
  vid: number;
}

export interface MvrpPduPayload extends MvrpDeviceRef {
  port: string;
  leaveAll: boolean;
  declarations: number;
}

export interface MvrpPduDiscardedPayload extends MvrpDeviceRef {
  port: string;
  reason: string;
}

export type MvrpDomainEvent =
  | { topic: 'mvrp.vlan.registered'; payload: MvrpVlanRegistrationPayload }
  | { topic: 'mvrp.vlan.deregistered'; payload: MvrpVlanDeregistrationPayload }
  | { topic: 'mvrp.pdu.sent'; payload: MvrpPduPayload }
  | { topic: 'mvrp.pdu.received'; payload: MvrpPduPayload }
  | { topic: 'mvrp.pdu.discarded'; payload: MvrpPduDiscardedPayload };

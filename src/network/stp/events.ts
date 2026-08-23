import type { StpPortRole } from './types';

export interface StpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface StpBpduSentPayload extends StpDeviceRef {
  port: string;
  rootMac: string;
  rootPriority: number;
  pathCost: number;
}

export interface StpBpduReceivedPayload extends StpDeviceRef {
  port: string;
  senderMac: string;
  rootMac: string;
}

export interface StpRoleChangedPayload extends StpDeviceRef {
  port: string;
  oldRole: StpPortRole;
  newRole: StpPortRole;
}

export interface StpStateChangedPayload extends StpDeviceRef {
  port: string;
  oldState: string;
  newState: string;
}

export interface StpRootChangedPayload extends StpDeviceRef {
  oldRootMac: string | null;
  newRootMac: string;
  newRootPriority: number;
  rootPort: string | null;
}

export interface StpTopologyChangePayload extends StpDeviceRef {
  origin: 'self' | 'received';
  port?: string;
}

export interface StpBpduGuardViolationPayload extends StpDeviceRef {
  port: string;
  senderMac: string;
}

export interface StpRootGuardChangedPayload extends StpDeviceRef {
  port: string;
  state: 'consistent' | 'inconsistent';
}

export interface StpLoopGuardChangedPayload extends StpDeviceRef {
  port: string;
  state: 'consistent' | 'inconsistent';
}

export interface StpErrDisableChangedPayload extends StpDeviceRef {
  port: string;
  cause: 'bpduguard';
  state: 'err-disabled' | 'recovered';
}

export interface StpPortfastLostPayload extends StpDeviceRef {
  port: string;
  senderMac: string;
}

export interface StpTcnReceivedPayload extends StpDeviceRef {
  port: string;
}

export interface StpTcnSentPayload extends StpDeviceRef {
  port: string;
}

export interface StpTopologyChangeDetectedPayload extends StpDeviceRef {
  isRoot: boolean;
}

/** Per-VLAN (PVST+) BPDU info aged out on a port. */
export interface StpBpduInfoExpiredPayload extends StpDeviceRef {
  port: string;
  vlan: number;
  designatedBridge: string;
}

/** Per-VLAN (PVST+) forwarding-state transition on a port. */
export interface StpPortStateChangedPayload extends StpDeviceRef {
  port: string;
  vlan: number;
  oldState: string | null;
  newState: string;
}

export type StpDomainEvent =
  | { topic: 'stp.bpdu.sent'; payload: StpBpduSentPayload }
  | { topic: 'stp.bpdu.received'; payload: StpBpduReceivedPayload }
  | { topic: 'stp.role.changed'; payload: StpRoleChangedPayload }
  | { topic: 'stp.state.changed'; payload: StpStateChangedPayload }
  | { topic: 'stp.root.changed'; payload: StpRootChangedPayload }
  | { topic: 'stp.topology.change'; payload: StpTopologyChangePayload }
  | { topic: 'stp.bpdu-guard.violation'; payload: StpBpduGuardViolationPayload }
  | { topic: 'stp.root-guard.changed'; payload: StpRootGuardChangedPayload }
  | { topic: 'stp.loop-guard.changed'; payload: StpLoopGuardChangedPayload }
  | { topic: 'stp.errdisable.changed'; payload: StpErrDisableChangedPayload }
  | { topic: 'stp.portfast.lost'; payload: StpPortfastLostPayload }
  | { topic: 'stp.tcn.received'; payload: StpTcnReceivedPayload }
  | { topic: 'stp.tcn.sent'; payload: StpTcnSentPayload }
  | { topic: 'stp.topology-change.detected'; payload: StpTopologyChangeDetectedPayload }
  | { topic: 'stp.bpdu-info.expired'; payload: StpBpduInfoExpiredPayload }
  | { topic: 'stp.port-state.changed'; payload: StpPortStateChangedPayload };

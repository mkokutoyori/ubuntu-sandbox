import type { SlaOperationState, SlaOperationType, SlaReturnCode } from './types';

export interface IpSlaDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface IpSlaProbeStartedPayload extends IpSlaDeviceRef {
  operationId: number;
  type: SlaOperationType;
  target: string | null;
}

export interface IpSlaProbeCompletedPayload extends IpSlaDeviceRef {
  operationId: number;
  type: SlaOperationType;
  target: string | null;
  returnCode: SlaReturnCode;
  rttMs: number | null;
  diagText: string;
}

export interface IpSlaOperationStateChangedPayload extends IpSlaDeviceRef {
  operationId: number;
  oldState: SlaOperationState;
  newState: SlaOperationState;
  reason: 'config' | 'schedule' | 'life-expired' | 'ageout' | 'restart' | 'trigger';
}

export interface IpSlaReactionPayload extends IpSlaDeviceRef {
  operationId: number;
  element: string;
  thresholdValue: number;
  measuredValue: number;
  actionType: string;
}

export interface IpSlaResponderPortPayload extends IpSlaDeviceRef {
  port: number;
  protocol: string;
  permanent: boolean;
}

export interface TrackStateChangedPayload extends IpSlaDeviceRef {
  objectId: number;
  description: string;
  oldState: 'up' | 'down';
  newState: 'up' | 'down';
  changeCount: number;
}

export type IpSlaDomainEvent =
  | { topic: 'ipsla.probe.started'; payload: IpSlaProbeStartedPayload }
  | { topic: 'ipsla.probe.completed'; payload: IpSlaProbeCompletedPayload }
  | { topic: 'ipsla.operation.state-changed'; payload: IpSlaOperationStateChangedPayload }
  | { topic: 'ipsla.reaction.triggered'; payload: IpSlaReactionPayload }
  | { topic: 'ipsla.reaction.cleared'; payload: IpSlaReactionPayload }
  | { topic: 'ipsla.responder.port-opened'; payload: IpSlaResponderPortPayload }
  | { topic: 'ipsla.responder.port-closed'; payload: IpSlaResponderPortPayload }
  | { topic: 'track.state.changed'; payload: TrackStateChangedPayload };

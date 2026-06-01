import type { UdldPortStateName, UdldMode, UdldOpcode } from './types';

export interface UdldDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface UdldPacketSentPayload extends UdldDeviceRef {
  port: string;
  opcode: UdldOpcode;
  echoCount: number;
}

export interface UdldPacketReceivedPayload extends UdldDeviceRef {
  port: string;
  fromDeviceId: string;
  fromPortId: string;
  opcode: UdldOpcode;
}

export interface UdldNeighborChangedPayload extends UdldDeviceRef {
  port: string;
  remoteDeviceId: string;
  remotePortId: string;
  added: boolean;
}

export interface UdldStateChangedPayload extends UdldDeviceRef {
  port: string;
  oldState: UdldPortStateName;
  newState: UdldPortStateName;
  mode: UdldMode;
  reason: 'config' | 'peer' | 'timeout' | 'link' | 'echo' | 'reset';
}

export interface UdldErrDisablePayload extends UdldDeviceRef {
  port: string;
  reason: 'aggressive-timeout' | 'neighbor-mismatch' | 'unidirectional';
}

export type UdldDomainEvent =
  | { topic: 'udld.packet.sent'; payload: UdldPacketSentPayload }
  | { topic: 'udld.packet.received'; payload: UdldPacketReceivedPayload }
  | { topic: 'udld.neighbor.changed'; payload: UdldNeighborChangedPayload }
  | { topic: 'udld.state.changed'; payload: UdldStateChangedPayload }
  | { topic: 'udld.err-disable'; payload: UdldErrDisablePayload };

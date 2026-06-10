import type { TcpState, TcpCloseReason } from './types';

export interface TcpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface TcpSegmentSentPayload extends TcpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  flagsText: string;
  sequence: number;
  acknowledgement: number;
  payloadSize: number;
}

export interface TcpSegmentReceivedPayload extends TcpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  flagsText: string;
  sequence: number;
  acknowledgement: number;
  payloadSize: number;
}

export interface TcpStateChangedPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  oldState: TcpState;
  newState: TcpState;
}

export interface TcpConnectionOpenedPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  passive: boolean;
}

export interface TcpConnectionClosedPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  reason: TcpCloseReason;
}

export interface TcpListenerChangedPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  added: boolean;
}

export interface TcpSegmentDroppedPayload extends TcpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  reason: 'no-listener' | 'no-socket' | 'bad-state' | 'no-egress' | 'no-source-ip' | 'disabled' | 'bad-checksum';
}

export type TcpDomainEvent =
  | { topic: 'tcp.segment.sent'; payload: TcpSegmentSentPayload }
  | { topic: 'tcp.segment.received'; payload: TcpSegmentReceivedPayload }
  | { topic: 'tcp.state.changed'; payload: TcpStateChangedPayload }
  | { topic: 'tcp.connection.opened'; payload: TcpConnectionOpenedPayload }
  | { topic: 'tcp.connection.closed'; payload: TcpConnectionClosedPayload }
  | { topic: 'tcp.listener.changed'; payload: TcpListenerChangedPayload }
  | { topic: 'tcp.segment.dropped'; payload: TcpSegmentDroppedPayload };

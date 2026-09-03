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
  /**
   * True when this device ACCEPTED the connection, false when it dialled
   * out — the same flag `TcpConnectionOpenedPayload` already carries.
   * Without it a subscriber cannot tell the two apart, which is how a
   * router came to log its own refused outbound telnet as
   * `Connection from 10.0.0.1:23 closed (rst)`.
   */
  passive: boolean;
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
  reason: 'no-listener' | 'no-socket' | 'bad-state' | 'no-egress' | 'no-source-ip' | 'disabled' | 'bad-checksum' | 'no-ephemeral' | 'listen-ignores-segment';
}

/** PRD-TCP.md P1 — a segment (SYN/data/FIN) was resent by the RTO timer. */
export interface TcpRetransmitPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  sequence: number;
  attempt: number;
  rtoMs: number;
}

export type TcpDomainEvent =
  | { topic: 'tcp.segment.sent'; payload: TcpSegmentSentPayload }
  | { topic: 'tcp.segment.received'; payload: TcpSegmentReceivedPayload }
  | { topic: 'tcp.state.changed'; payload: TcpStateChangedPayload }
  | { topic: 'tcp.connection.opened'; payload: TcpConnectionOpenedPayload }
  | { topic: 'tcp.connection.closed'; payload: TcpConnectionClosedPayload }
  | { topic: 'tcp.listener.changed'; payload: TcpListenerChangedPayload }
  | { topic: 'tcp.segment.dropped'; payload: TcpSegmentDroppedPayload }
  | { topic: 'tcp.retransmit'; payload: TcpRetransmitPayload };

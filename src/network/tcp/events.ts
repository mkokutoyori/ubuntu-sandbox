import type { TcpState, TcpCloseReason, TcpErrorReport } from './types';
import type { IPv4Packet, IPv6Packet } from '@/network/core/types';

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
  /**
   * Interface the segment left by, `lo` when the stack delivered it in
   * process instead of putting a frame on a wire. A capture reads this
   * to know whether a port tap has already seen the frame.
   */
  iface: string;
  /**
   * The very packet delivered in process, present only when `iface` is
   * `lo`: nothing else ever puts it on a wire, so a capture of the
   * loopback decodes THIS object, as a capture of a port decodes its frame.
   */
  packet?: IPv4Packet | IPv6Packet;
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

export type TcpDropReason =
  | 'no-listener' | 'no-socket' | 'bad-state' | 'no-egress' | 'no-source-ip' | 'disabled'
  | 'bad-checksum' | 'no-ephemeral' | 'addr-in-use' | 'listen-ignores-segment'
  | 'non-unicast-destination' | 'invalid-source' | 'icmp-out-of-window' | 'ttl-below-floor';

export interface TcpSegmentDroppedPayload extends TcpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  reason: TcpDropReason;
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

export interface TcpErrorReportedPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  report: TcpErrorReport;
}

export interface TcpEcnReactionPayload extends TcpDeviceRef {
  localIp: string;
  localPort: number;
  remoteIp: string;
  remotePort: number;
  congestionWindow: number;
  slowStartThreshold: number;
}

export type TcpDomainEvent =
  | { topic: 'tcp.segment.sent'; payload: TcpSegmentSentPayload }
  | { topic: 'tcp.segment.received'; payload: TcpSegmentReceivedPayload }
  | { topic: 'tcp.state.changed'; payload: TcpStateChangedPayload }
  | { topic: 'tcp.connection.opened'; payload: TcpConnectionOpenedPayload }
  | { topic: 'tcp.connection.closed'; payload: TcpConnectionClosedPayload }
  | { topic: 'tcp.listener.changed'; payload: TcpListenerChangedPayload }
  | { topic: 'tcp.segment.dropped'; payload: TcpSegmentDroppedPayload }
  | { topic: 'tcp.retransmit'; payload: TcpRetransmitPayload }
  | { topic: 'tcp.error.reported'; payload: TcpErrorReportedPayload }
  | { topic: 'tcp.ecn.reaction'; payload: TcpEcnReactionPayload };

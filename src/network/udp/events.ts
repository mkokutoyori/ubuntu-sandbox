export interface UdpDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface UdpDatagramSentPayload extends UdpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  payloadSize: number;
}

export interface UdpDatagramReceivedPayload extends UdpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  payloadSize: number;
}

export type UdpDropReason =
  | 'no-listener'
  | 'no-route'
  | 'no-source-ip'
  | 'arp-timeout'
  | 'disabled';

export interface UdpDatagramDroppedPayload extends UdpDeviceRef {
  sourceIp: string;
  destinationIp: string;
  sourcePort: number;
  destinationPort: number;
  reason: UdpDropReason;
}

export interface UdpListenerChangedPayload extends UdpDeviceRef {
  localIp: string;
  localPort: number;
  added: boolean;
}

export type UdpDomainEvent =
  | { topic: 'udp.datagram.sent'; payload: UdpDatagramSentPayload }
  | { topic: 'udp.datagram.received'; payload: UdpDatagramReceivedPayload }
  | { topic: 'udp.datagram.dropped'; payload: UdpDatagramDroppedPayload }
  | { topic: 'udp.listener.changed'; payload: UdpListenerChangedPayload };

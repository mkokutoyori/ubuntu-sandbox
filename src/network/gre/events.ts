export interface GreDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface GrePacketEncapsulatedPayload extends GreDeviceRef {
  tunnelId: string;
  sourceIp: string;
  destinationIp: string;
  protocolType: number;
  key: number | null;
}

export interface GrePacketDecapsulatedPayload extends GreDeviceRef {
  tunnelId: string;
  sourceIp: string;
  destinationIp: string;
  protocolType: number;
  innerSourceIp: string | null;
  innerDestinationIp: string | null;
}

export interface GrePacketDroppedPayload extends GreDeviceRef {
  sourceIp: string;
  destinationIp: string;
  reason: 'no-tunnel' | 'key-mismatch' | 'no-source-ip' | 'no-egress' | 'disabled' | 'tunnel-down';
}

export interface GreTunnelChangedPayload extends GreDeviceRef {
  tunnelId: string;
  sourceIp: string;
  destinationIp: string;
  added: boolean;
}

export type GreDomainEvent =
  | { topic: 'gre.packet.encapsulated'; payload: GrePacketEncapsulatedPayload }
  | { topic: 'gre.packet.decapsulated'; payload: GrePacketDecapsulatedPayload }
  | { topic: 'gre.packet.dropped'; payload: GrePacketDroppedPayload }
  | { topic: 'gre.tunnel.changed'; payload: GreTunnelChangedPayload };

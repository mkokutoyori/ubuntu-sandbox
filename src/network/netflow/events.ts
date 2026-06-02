export interface NetFlowDeviceRef {
  deviceId: string;
  hostname: string;
}

export interface NetFlowFlowRecordedPayload extends NetFlowDeviceRef {
  sourceIp: string;
  destinationIp: string;
  protocol: number;
  bytes: number;
  packets: number;
}

export interface NetFlowFlowExpiredPayload extends NetFlowDeviceRef {
  sourceIp: string;
  destinationIp: string;
  protocol: number;
  bytes: number;
  packets: number;
  reason: 'active-timeout' | 'inactive-timeout' | 'tcp-rst' | 'tcp-fin' | 'cache-full' | 'manual';
}

export interface NetFlowPacketExportedPayload extends NetFlowDeviceRef {
  collectorIp: string;
  flowCount: number;
  flowSequence: number;
  sysUptimeMs: number;
}

export interface NetFlowCollectorChangedPayload extends NetFlowDeviceRef {
  collectorIp: string;
  port: number;
  added: boolean;
}

export type NetFlowDomainEvent =
  | { topic: 'netflow.flow.recorded'; payload: NetFlowFlowRecordedPayload }
  | { topic: 'netflow.flow.expired'; payload: NetFlowFlowExpiredPayload }
  | { topic: 'netflow.packet.exported'; payload: NetFlowPacketExportedPayload }
  | { topic: 'netflow.collector.changed'; payload: NetFlowCollectorChangedPayload };

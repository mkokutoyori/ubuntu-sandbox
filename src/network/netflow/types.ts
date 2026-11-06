import { simulationNowMs } from '@/network/core/SystemClock';

import type { NetworkPdu } from '@/network/core/NetworkPdu';
export const UDP_PORT_NETFLOW = 2055;
export const NETFLOW_V5_MAX_RECORDS = 30;
export const NETFLOW_V5_VERSION = 5;

export interface NetFlowV5Record {
  sourceIp: string;
  destinationIp: string;
  nextHopIp: string;
  inputIfIndex: number;
  outputIfIndex: number;
  packets: number;
  octets: number;
  firstSwitchedMs: number;
  lastSwitchedMs: number;
  sourcePort: number;
  destinationPort: number;
  tcpFlags: number;
  protocol: number;
  tos: number;
  sourceAs: number;
  destinationAs: number;
  sourceMask: number;
  destinationMask: number;
}

export interface NetFlowV5Header {
  version: 5;
  count: number;
  sysUptimeMs: number;
  unixSecs: number;
  unixNsecs: number;
  flowSequence: number;
  engineType: number;
  engineId: number;
  samplingInterval: number;
}

export interface NetFlowV5Packet extends NetworkPdu {
  type: 'netflow-v5';
  header: NetFlowV5Header;
  records: NetFlowV5Record[];
}

export const NETFLOW_V9_VERSION = 9;
export const NETFLOW_V9_TEMPLATE_ID = 256;
export const NETFLOW_V9_TEMPLATE_FIELDS: ReadonlyArray<{ readonly type: number; readonly length: number; readonly name: string }> = Object.freeze([
  { type: 8, length: 4, name: 'IPV4_SRC_ADDR' },
  { type: 12, length: 4, name: 'IPV4_DST_ADDR' },
  { type: 15, length: 4, name: 'IPV4_NEXT_HOP' },
  { type: 10, length: 4, name: 'INPUT_SNMP' },
  { type: 14, length: 4, name: 'OUTPUT_SNMP' },
  { type: 2, length: 4, name: 'IN_PKTS' },
  { type: 1, length: 4, name: 'IN_BYTES' },
  { type: 22, length: 4, name: 'FIRST_SWITCHED' },
  { type: 21, length: 4, name: 'LAST_SWITCHED' },
  { type: 7, length: 2, name: 'L4_SRC_PORT' },
  { type: 11, length: 2, name: 'L4_DST_PORT' },
  { type: 6, length: 1, name: 'TCP_FLAGS' },
  { type: 4, length: 1, name: 'PROTOCOL' },
  { type: 5, length: 1, name: 'SRC_TOS' },
]);
export const NETFLOW_V9_RECORD_BYTES = NETFLOW_V9_TEMPLATE_FIELDS.reduce((sum, field) => sum + field.length, 0);

export interface NetFlowV9Header {
  version: 9;
  count: number;
  sysUptimeMs: number;
  unixSecs: number;
  packetSequence: number;
  sourceId: number;
}

export interface NetFlowV9TemplateFlowSet {
  flowSetId: 0;
  templates: Array<{ templateId: number; fields: ReadonlyArray<{ type: number; length: number }> }>;
}

export interface NetFlowV9DataFlowSet {
  flowSetId: number;
  records: NetFlowV5Record[];
}

export interface NetFlowV9Packet extends NetworkPdu {
  type: 'netflow-v9';
  header: NetFlowV9Header;
  flowSets: Array<NetFlowV9TemplateFlowSet | NetFlowV9DataFlowSet>;
}

export interface NetFlowCollector {
  ip: string;
  port: number;
  enabled: boolean;
  exportedPackets: number;
  exportedFlows: number;
  lastExportMs: number;
  lastTemplateMs: number | null;
}

export interface NetFlowConfig {
  version: 5 | 9;
  templateRefreshPackets: number;
  templateRefreshSeconds: number | null;
  enabled: boolean;
  collectors: Map<string, NetFlowCollector>;
  activeTimeoutSec: number;
  inactiveTimeoutSec: number;
  exportIntervalMs: number;
  samplingInterval: number;
  engineType: number;
  engineId: number;
  sourceInterface: string | null;
}

export function createDefaultNetFlowConfig(): NetFlowConfig {
  return {
    version: 5,
    templateRefreshPackets: 20,
    templateRefreshSeconds: null,
    enabled: false,
    collectors: new Map(),
    activeTimeoutSec: 1800,
    inactiveTimeoutSec: 15,
    exportIntervalMs: 1000,
    samplingInterval: 1,
    engineType: 1, engineId: 0,
    sourceInterface: null,
  };
}

export function defaultCollector(ip: string, port = UDP_PORT_NETFLOW): NetFlowCollector {
  return { ip, port, enabled: true, exportedPackets: 0, exportedFlows: 0, lastExportMs: 0, lastTemplateMs: null };
}

export function flowKey(r: { sourceIp: string; destinationIp: string; sourcePort: number; destinationPort: number; protocol: number; inputIfIndex: number; tos: number }): string {
  return `${r.sourceIp}|${r.destinationIp}|${r.sourcePort}|${r.destinationPort}|${r.protocol}|${r.inputIfIndex}|${r.tos}`;
}

export function newRecord(input: {
  sourceIp: string; destinationIp: string;
  inputIfIndex?: number; outputIfIndex?: number;
  sourcePort?: number; destinationPort?: number;
  protocol: number; bytes?: number; packets?: number; tos?: number;
  nextHopIp?: string; tcpFlags?: number;
}, nowMs?: number): NetFlowV5Record {
  const now = nowMs ?? simulationNowMs();
  return {
    sourceIp: input.sourceIp,
    destinationIp: input.destinationIp,
    nextHopIp: input.nextHopIp ?? '0.0.0.0',
    inputIfIndex: input.inputIfIndex ?? 0,
    outputIfIndex: input.outputIfIndex ?? 0,
    packets: input.packets ?? 1,
    octets: input.bytes ?? 0,
    firstSwitchedMs: now, lastSwitchedMs: now,
    sourcePort: input.sourcePort ?? 0,
    destinationPort: input.destinationPort ?? 0,
    tcpFlags: input.tcpFlags ?? 0,
    protocol: input.protocol,
    tos: input.tos ?? 0,
    sourceAs: 0, destinationAs: 0,
    sourceMask: 0, destinationMask: 0,
  };
}

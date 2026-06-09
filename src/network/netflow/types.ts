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

export interface NetFlowCollector {
  ip: string;
  port: number;
  enabled: boolean;
  exportedPackets: number;
  exportedFlows: number;
  lastExportMs: number;
}

export interface NetFlowConfig {
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
  return { ip, port, enabled: true, exportedPackets: 0, exportedFlows: 0, lastExportMs: 0 };
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
}): NetFlowV5Record {
  const now = Date.now();
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

import type { StpBpdu, StpPortRole } from './types';

const TIMER_UNITS_PER_SECOND = 256;
const VERSION_STP = 0;
const VERSION_RSTP = 2;
const VERSION_MSTP = 3;
const TYPE_CONFIG = 0x00;
const TYPE_RSTP = 0x02;
const TYPE_TCN = 0x80;
const FLAG_TOPOLOGY_CHANGE = 0x01;
const FLAG_PROPOSAL = 0x02;
const FLAG_LEARNING = 0x10;
const FLAG_FORWARDING = 0x20;
const FLAG_AGREEMENT = 0x40;
const FLAG_TOPOLOGY_CHANGE_ACK = 0x80;
const PORT_ROLE_SHIFT = 2;
const MST_CONFIG_NAME_BYTES = 32;
const MST_VERSION_3_LENGTH = 64;
const MST_REMAINING_HOPS = 20;
const MST_CONFIG_FORMAT_SELECTOR = 0;
const PVST_ORIGINATING_VLAN_TLV_TYPE = 0x0000;
const PVST_ORIGINATING_VLAN_TLV_VALUE_BYTES = 2;

export const STP_LLC_HEADER: readonly number[] = [0x42, 0x42, 0x03];
export const PVST_SNAP_HEADER: readonly number[] = [0xaa, 0xaa, 0x03, 0x00, 0x00, 0x0c, 0x01, 0x0b];

const ROLE_CODES: Readonly<Record<StpPortRole, number>> = {
  disabled: 0, alternate: 1, backup: 1, root: 2, designated: 3,
};

function u16(value: number): number[] {
  return [(value >>> 8) & 0xff, value & 0xff];
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function timer(seconds: number): number[] {
  return u16(Math.round(seconds * TIMER_UNITS_PER_SECOND));
}

function bridgeId(id: { priority: number; mac: string }): number[] {
  return [...u16(id.priority), ...id.mac.split(':').map((part) => parseInt(part, 16) & 0xff)];
}

function hexBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

function paddedName(name: string): number[] {
  const encoded = Array.from(new TextEncoder().encode(name)).slice(0, MST_CONFIG_NAME_BYTES);
  while (encoded.length < MST_CONFIG_NAME_BYTES) encoded.push(0);
  return encoded;
}

function flagsOf(bpdu: StpBpdu): number {
  let flags = 0;
  if (bpdu.topologyChange) flags |= FLAG_TOPOLOGY_CHANGE;
  if (bpdu.topologyChangeAck) flags |= FLAG_TOPOLOGY_CHANGE_ACK;
  if (bpdu.version === 0) return flags;
  if (bpdu.proposal) flags |= FLAG_PROPOSAL;
  if (bpdu.agreement) flags |= FLAG_AGREEMENT;
  if (bpdu.senderRole !== undefined) flags |= ROLE_CODES[bpdu.senderRole] << PORT_ROLE_SHIFT;
  if (bpdu.senderLearning) flags |= FLAG_LEARNING;
  if (bpdu.senderForwarding) flags |= FLAG_FORWARDING;
  return flags;
}

function configFields(bpdu: StpBpdu): number[] {
  return [
    flagsOf(bpdu),
    ...bridgeId(bpdu.rootBridge),
    ...u32(bpdu.rootPathCost),
    ...bridgeId(bpdu.senderBridge),
    ...u16(bpdu.portId),
    ...timer(bpdu.messageAgeSec),
    ...timer(bpdu.maxAgeSec),
    ...timer(bpdu.helloSec),
    ...timer(bpdu.forwardDelaySec),
  ];
}

function mstExtension(bpdu: StpBpdu): number[] {
  const identifier = bpdu.mstConfigId;
  return [
    0,
    ...u16(MST_VERSION_3_LENGTH),
    MST_CONFIG_FORMAT_SELECTOR,
    ...paddedName(identifier?.name ?? ''),
    ...u16(identifier?.revision ?? 0),
    ...hexBytes(identifier?.digest ?? ''),
    ...u32(0),
    ...bridgeId(bpdu.senderBridge),
    MST_REMAINING_HOPS,
  ];
}

export function stpPayloadBytes(bpdu: StpBpdu): number[] {
  if (bpdu.bpduType === 'tcn') return [0, 0, VERSION_STP, TYPE_TCN];
  if (bpdu.mstConfigId !== undefined) {
    return [0, 0, VERSION_MSTP, TYPE_RSTP, ...configFields(bpdu), ...mstExtension(bpdu)];
  }
  if (bpdu.version === VERSION_RSTP) return [0, 0, VERSION_RSTP, TYPE_RSTP, ...configFields(bpdu), 0];
  return [0, 0, VERSION_STP, TYPE_CONFIG, ...configFields(bpdu)];
}

export function pvstTrailerBytes(vlan: number): number[] {
  return [...u16(PVST_ORIGINATING_VLAN_TLV_TYPE), ...u16(PVST_ORIGINATING_VLAN_TLV_VALUE_BYTES), ...u16(vlan)];
}

import { MACAddress } from '../../../core/types';

const GROUP_PREFIXES: ReadonlyArray<readonly [number, string]> = [
  [0, '00:09:0f:09'],
  [256, 'e0:23:ff:fc'],
  [512, 'e0:23:ff:fd'],
  [768, 'e0:23:ff:fe'],
];

const VCLUSTER_BASE: Readonly<Record<1 | 2, number>> = { 1: 0x00, 2: 0x20 };

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function clusterVirtualMac(
  groupId: number, interfaceIndex: number, vcluster: 1 | 2 = 1,
): MACAddress {
  const bounded = Math.max(0, Math.floor(groupId));
  let prefix = GROUP_PREFIXES[0][1];
  for (const [floor, candidate] of GROUP_PREFIXES) {
    if (bounded >= floor) prefix = candidate;
  }
  const low = VCLUSTER_BASE[vcluster] + interfaceIndex;
  return new MACAddress(`${prefix}:${hex(bounded % 256)}:${hex(low & 0xff)}`);
}

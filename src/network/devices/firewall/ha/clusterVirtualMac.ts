import { MACAddress } from '../../../core/types';

const VIRTUAL_MAC_PREFIX = '00:09:0f:09';
const VCLUSTER_1 = 0x00;

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function clusterVirtualMac(groupId: number, interfaceIndex: number): MACAddress {
  return new MACAddress(
    `${VIRTUAL_MAC_PREFIX}:${hex(groupId % 256)}:${hex(VCLUSTER_1 + interfaceIndex)}`);
}

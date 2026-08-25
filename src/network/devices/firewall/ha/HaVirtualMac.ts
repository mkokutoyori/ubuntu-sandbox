const GROUP_PREFIXES: ReadonlyArray<readonly [number, string]> = [
  [0, '00:09:0f:09'],
  [256, 'e0:23:ff:fc'],
  [512, 'e0:23:ff:fd'],
  [768, 'e0:23:ff:fe'],
];

const VCLUSTER_BASE: Readonly<Record<1 | 2, number>> = { 1: 0x00, 2: 0x20 };

function hex2(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function haVirtualMac(
  groupId: number, interfaceIndex: number, vcluster: 1 | 2 = 1,
): string {
  const bounded = Math.max(0, Math.floor(groupId));
  let prefix = GROUP_PREFIXES[0][1];
  for (const [floor, candidate] of GROUP_PREFIXES) {
    if (bounded >= floor) prefix = candidate;
  }
  const low = VCLUSTER_BASE[vcluster] + interfaceIndex;
  return `${prefix}:${hex2(bounded % 256)}:${hex2(low & 0xff)}`;
}

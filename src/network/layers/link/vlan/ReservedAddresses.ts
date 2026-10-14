export type BridgeComponentKind = 'c-vlan' | 's-vlan' | 'tpmr';

const BLOCK_PREFIX = '01:80:c2:00:00:';

const C_VLAN_RESERVED = Object.freeze(
  Array.from({ length: 16 }, (_, last) => last),
);

const S_VLAN_RESERVED = Object.freeze([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0e]);

const TPMR_RESERVED = Object.freeze([0x01, 0x02, 0x04, 0x0e]);

const RESERVED_BY_KIND: Readonly<Record<BridgeComponentKind, readonly number[]>> = Object.freeze({
  'c-vlan': C_VLAN_RESERVED,
  's-vlan': S_VLAN_RESERVED,
  tpmr: TPMR_RESERVED,
});

export function isReservedBridgeAddress(kind: BridgeComponentKind, destination: string): boolean {
  const text = destination.toLowerCase().replace(/-/g, ':');
  if (!text.startsWith(BLOCK_PREFIX) || text.length !== BLOCK_PREFIX.length + 2) return false;
  const last = Number.parseInt(text.slice(BLOCK_PREFIX.length), 16);
  return RESERVED_BY_KIND[kind].includes(last);
}

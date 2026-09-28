import { hmac } from '@/crypto/mac/hmac';
import { MD5 } from '@/crypto/hash';
import type { MstRegion } from '@/network/stp/types';

const MAX_VID = 4094;
const TABLE_ENTRIES = MAX_VID + 2;

const DIGEST_KEY = Uint8Array.from([
  0x13, 0xac, 0x06, 0xa6, 0x2e, 0x47, 0xfd, 0x51,
  0xf9, 0x5d, 0x2b, 0xa2, 0x43, 0xcd, 0x03, 0x46,
]);

export interface MstConfigIdentifier {
  readonly name: string;
  readonly revision: number;
  readonly digest: string;
}

export type MstInstanceMap = ReadonlyMap<number, ReadonlySet<number>>;

export function vlanToInstanceTable(instances: MstInstanceMap): Uint16Array {
  const table = new Uint16Array(TABLE_ENTRIES);
  for (const [instanceId, members] of instances) {
    for (const vlan of members) {
      if (vlan >= 1 && vlan <= MAX_VID) table[vlan] = instanceId;
    }
  }
  return table;
}

export function mstConfigDigest(instances: MstInstanceMap): string {
  const table = vlanToInstanceTable(instances);
  const bytes = new Uint8Array(TABLE_ENTRIES * 2);
  for (let i = 0; i < TABLE_ENTRIES; i++) {
    bytes[i * 2] = (table[i] >> 8) & 0xff;
    bytes[i * 2 + 1] = table[i] & 0xff;
  }
  return [...hmac(MD5, DIGEST_KEY, bytes)]
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function mstConfigIdentifier(region: MstRegion): MstConfigIdentifier {
  return {
    name: region.name,
    revision: region.revision,
    digest: mstConfigDigest(region.instances),
  };
}

export function sameMstRegion(a: MstConfigIdentifier, b: MstConfigIdentifier): boolean {
  return a.name === b.name && a.revision === b.revision && a.digest === b.digest;
}

export function vlansMappedToInstanceZero(instances: MstInstanceMap): number[] {
  const table = vlanToInstanceTable(instances);
  const unmapped: number[] = [];
  for (let vlan = 1; vlan <= MAX_VID; vlan++) if (table[vlan] === 0) unmapped.push(vlan);
  return unmapped;
}

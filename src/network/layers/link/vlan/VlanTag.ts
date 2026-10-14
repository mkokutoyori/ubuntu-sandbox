import type { Dot1QTag } from '../../../core/types';
import { VID_WILDCARD, VlanId } from './VlanId';

export type { Dot1QTag };

export const TPID_C_TAG = 0x8100;
export const TPID_S_TAG = 0x88a8;
export const TPID_I_TAG = 0x88e7;

export const TAG_BYTES = 4;
export const PCP_MAX = 7;

export interface VlanTagFields {
  readonly vid: number;
  readonly pcp?: number;
  readonly dei?: number;
  readonly tpid?: number;
}

export function makeVlanTag(fields: VlanTagFields): Dot1QTag {
  const { vid, pcp = 0, dei = 0, tpid = TPID_C_TAG } = fields;
  if (tpid !== TPID_C_TAG && tpid !== TPID_S_TAG) {
    throw new RangeError(`TPID 0x${tpid.toString(16)} is not a VLAN tag EtherType`);
  }
  if (!Number.isInteger(pcp) || pcp < 0 || pcp > PCP_MAX) {
    throw new RangeError(`PCP ${pcp} does not fit the 3-bit field`);
  }
  if (dei !== 0 && dei !== 1) throw new RangeError(`DEI ${dei} is not a single bit`);
  const id = VlanId.of(vid);
  if (id.isWildcard) throw new RangeError('VID 0xFFF shall not be transmitted in a tag header');
  return Object.freeze({ tpid, pcp, dei, vid: id.value });
}

export function encodeTci(tag: Dot1QTag): number {
  return ((tag.pcp & 0x7) << 13) | ((tag.dei & 0x1) << 12) | (tag.vid & 0xfff);
}

export function decodeTci(tpid: number, tci: number): Dot1QTag {
  return Object.freeze({
    tpid, pcp: (tci >> 13) & 0x7, dei: (tci >> 12) & 0x1, vid: tci & 0xfff,
  });
}

export function encodeTagBytes(tag: Dot1QTag): Uint8Array {
  const tci = encodeTci(tag);
  return Uint8Array.of(tag.tpid >> 8, tag.tpid & 0xff, tci >> 8, tci & 0xff);
}

export function decodeTagBytes(bytes: Uint8Array): Dot1QTag | undefined {
  if (bytes.length < TAG_BYTES) return undefined;
  const tpid = (bytes[0] << 8) | bytes[1];
  if (tpid !== TPID_C_TAG && tpid !== TPID_S_TAG) return undefined;
  return decodeTci(tpid, (bytes[2] << 8) | bytes[3]);
}

export function isPriorityTagged(tag: Dot1QTag | undefined): boolean {
  return tag !== undefined && tag.vid === 0;
}

export function isReservedVid(tag: Dot1QTag): boolean {
  return tag.vid === VID_WILDCARD;
}

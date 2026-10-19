/**
 * IEEE Std 802.1Q-2022, clause 9 (docs/rfc/dot1q/8021Q-2022.pdf): the VLAN tag.
 *
 *   9.3  a tag is a TPID, the TCI and, depending on the type, more
 *   9.4  the TPID is a two-octet EtherType
 *   9.6  the TCI is two octets: PCP (3 bits), DEI (1 bit), VID (12 bits)
 *   Table 9-1  C-TAG 0x8100, S-TAG 0x88A8, I-TAG 0x88E7
 *   Table 9-2  VID 0 is the null VID (priority only), 1 the default PVID,
 *              0xFFF reserved: never transmitted in a tag header
 *   9.6 NOTE 2 the former CFI bit is now the DEI
 *
 * Measured on a git worktree of HEAD before the change: VlanId and VlanTag do
 * not exist, so the whole file fails to load; the behaviour was a magic
 * 0x8100 / 0x88a8 literal written in four places. There is no witness: the
 * module is new, and the neighbouring switch suites are the non-regression.
 */
import { describe, it, expect } from 'vitest';
import {
  TPID_C_TAG, TPID_S_TAG, TPID_I_TAG, TAG_BYTES,
  makeVlanTag, encodeTci, decodeTci, encodeTagBytes, decodeTagBytes,
  isPriorityTagged, isReservedVid,
} from '@/network/layers/link/vlan/VlanTag';
import {
  VlanId, VID_NULL, VID_DEFAULT_PVID, VID_DEFAULT_SR_PVID, VID_WILDCARD, VID_MAX_CONFIGURABLE,
} from '@/network/layers/link/vlan/VlanId';

describe('Table 9-1: tag EtherTypes', () => {
  it('uses the allocated values', () => {
    expect(TPID_C_TAG).toBe(0x8100);
    expect(TPID_S_TAG).toBe(0x88a8);
    expect(TPID_I_TAG).toBe(0x88e7);
  });
});

describe('Table 9-2: reserved VID values', () => {
  it('names 0 the null VID, 1 the default PVID, 2 the default SR_PVID, 0xFFF the wildcard', () => {
    expect([VID_NULL, VID_DEFAULT_PVID, VID_DEFAULT_SR_PVID, VID_WILDCARD]).toEqual([0, 1, 2, 0xfff]);
    expect(VID_MAX_CONFIGURABLE).toBe(4094);
  });

  it('keeps 0 and 0xFFF out of what can be configured as a PVID or in a VID set', () => {
    expect(VlanId.of(0).isConfigurable).toBe(false);
    expect(VlanId.of(0xfff).isConfigurable).toBe(false);
    expect(VlanId.of(1).isConfigurable).toBe(true);
    expect(VlanId.of(4094).isConfigurable).toBe(true);
  });

  it('refuses a value that does not fit the 12-bit field', () => {
    expect(() => VlanId.of(4096)).toThrow(RangeError);
    expect(() => VlanId.of(-1)).toThrow(RangeError);
    expect(VlanId.tryParse('4096')).toBeUndefined();
    expect(VlanId.tryParse('abc')).toBeUndefined();
    expect(VlanId.tryParse('100')?.value).toBe(100);
  });

  it('refuses to transmit VID 0xFFF in a tag header', () => {
    expect(() => makeVlanTag({ vid: 0xfff })).toThrow(/0xFFF/);
  });

  it('lets VID 0 through: a priority-tagged frame carries only priority', () => {
    const tag = makeVlanTag({ vid: 0, pcp: 5 });
    expect(isPriorityTagged(tag)).toBe(true);
    expect(isReservedVid(tag)).toBe(false);
  });
});

describe('9.6: TCI layout', () => {
  it('packs PCP in the top 3 bits, DEI in the next bit, VID in the low 12', () => {
    expect(encodeTci(makeVlanTag({ vid: 0x123, pcp: 5, dei: 1 }))).toBe((5 << 13) | (1 << 12) | 0x123);
  });

  it('round-trips every PCP, DEI and a spread of VIDs', () => {
    for (const pcp of [0, 1, 2, 3, 4, 5, 6, 7]) {
      for (const dei of [0, 1]) {
        for (const vid of [0, 1, 2, 100, 2047, 4094]) {
          const tag = makeVlanTag({ vid, pcp, dei });
          expect(decodeTci(tag.tpid, encodeTci(tag))).toEqual(tag);
        }
      }
    }
  });

  it('refuses a PCP or DEI outside its field', () => {
    expect(() => makeVlanTag({ vid: 10, pcp: 8 })).toThrow(RangeError);
    expect(() => makeVlanTag({ vid: 10, dei: 2 })).toThrow(RangeError);
  });
});

describe('9.3 / 9.4: the tag on the wire', () => {
  it('is TPID then TCI, four octets', () => {
    const bytes = encodeTagBytes(makeVlanTag({ vid: 100, pcp: 3 }));
    expect(bytes.length).toBe(TAG_BYTES);
    expect(Array.from(bytes)).toEqual([0x81, 0x00, 0x60, 0x64]);
  });

  it('uses the S-TAG EtherType for a service tag', () => {
    const bytes = encodeTagBytes(makeVlanTag({ vid: 200, tpid: TPID_S_TAG }));
    expect(Array.from(bytes.slice(0, 2))).toEqual([0x88, 0xa8]);
  });

  it('decodes by TPID and reads PCP, DEI and VID back', () => {
    const decoded = decodeTagBytes(Uint8Array.of(0x88, 0xa8, 0xb0, 0x2a));
    expect(decoded).toEqual({ tpid: 0x88a8, pcp: 5, dei: 1, vid: 0x02a });
  });

  it('does not decode a TPID that is not a VLAN tag, nor a truncated tag', () => {
    expect(decodeTagBytes(Uint8Array.of(0x08, 0x00, 0x00, 0x01))).toBeUndefined();
    expect(decodeTagBytes(Uint8Array.of(0x81, 0x00))).toBeUndefined();
  });

  it('refuses a tag whose TPID is not a VLAN tag EtherType', () => {
    expect(() => makeVlanTag({ vid: 10, tpid: 0x0800 })).toThrow(/EtherType/);
  });
});

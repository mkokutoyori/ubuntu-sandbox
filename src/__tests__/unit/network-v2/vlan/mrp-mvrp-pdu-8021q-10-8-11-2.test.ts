/**
 * IEEE Std 802.1Q-2022, 10.8 (MRPDU) and 11.2.3.1 (MVRP application elements),
 * docs/rfc/dot1q/8021Q-2022.pdf p.298-302 and 318-319:
 *
 *   10.8.1   MRPDU ::= ProtocolVersion, Message {, Message}, EndMark
 *            VectorHeader = LeaveAllEvent * 8192 + NumberOfValues
 *            ThreePackedEvents = ((e1 * 6) + e2) * 6 + e3, events 0..5
 *            (New JoinIn In JoinMt Mt Lv)
 *   10.8.2.4 AttributeListLength is absent from MVRPDUs
 *   10.8.3.4 an incomplete last VectorAttribute discards the whole PDU; the
 *            physical end of the PDU is an EndMark
 *   11.2.3.1 MVRP: EtherType 88-F5, Customer Bridge address 01-80-C2-00-00-21,
 *            Provider Bridge address 01-80-C2-00-00-0D, ProtocolVersion 0,
 *            AttributeType 1, AttributeLength 2, FirstValue = VID on two octets
 *            restricted to 0..4094
 *
 * Measured on a git worktree of HEAD before the change: mrp/ and mvrp/ do not
 * exist, so the file cannot load. No witness: new codec. The worked byte strings
 * are computed by hand from the BNF (two of my first expectations were wrong and
 * were corrected against the arithmetic, not against the encoder's output).
 */
import { describe, it, expect } from 'vitest';
import {
  encodeMrpdu, decodeMrpdu, packThreeEvents, unpackThreeEvents, incrementValue,
} from '@/network/mrp/MrpPdu';
import {
  encodeMvrp, decodeMvrp, MVRP_ETHERTYPE, MVRP_CUSTOMER_ADDRESS, MVRP_PROVIDER_ADDRESS,
} from '@/network/mvrp/MvrpPdu';

const hex = (bytes: Uint8Array): string => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(' ');

describe('10.8.2.10.1: ThreePackedEvents', () => {
  it('packs ((e1 * 6) + e2) * 6 + e3', () => {
    expect(Array.from(packThreeEvents(['joinIn', 'in', 'mt']))).toEqual([1 * 36 + 2 * 6 + 4]);
    expect(Array.from(packThreeEvents(['lv', 'lv', 'lv']))).toEqual([5 * 36 + 5 * 6 + 5]);
  });

  it('fills the unused slots of the last byte with 0 on transmission', () => {
    expect(Array.from(packThreeEvents(['joinIn']))).toEqual([36]);
    expect(Array.from(packThreeEvents(['new', 'joinIn', 'in', 'mt']))).toEqual([0 * 36 + 1 * 6 + 2, 4 * 36]);
  });

  it('ignores the unused slots on receipt and refuses a byte above 215', () => {
    expect(unpackThreeEvents(Uint8Array.of(36), 1)).toEqual(['joinIn']);
    expect(unpackThreeEvents(Uint8Array.of(216), 3)).toBeUndefined();
  });
});

describe('10.8.1: MVRPDU for a single JoinIn of VID 10', () => {
  const expected = '00 01 02 00 01 00 0a 24 00 00 00 00';

  it('encodes to the hand-computed bytes', () => {
    expect(hex(encodeMvrp({ leaveAll: false, declarations: [{ vid: 10, event: 'joinIn' }] }))).toBe(expected);
  });

  it('decodes them back', () => {
    const bytes = Uint8Array.from(expected.split(' ').map(h => Number.parseInt(h, 16)));
    expect(decodeMvrp(bytes)).toEqual({ ok: true, leaveAll: false, declarations: [{ vid: 10, event: 'joinIn' }] });
  });
});

describe('10.8.2.8 and 10.8.2.10: vectors', () => {
  it('packs consecutive VIDs in one vector whose FirstValue is the lowest', () => {
    const bytes = encodeMvrp({
      leaveAll: false,
      declarations: [10, 11, 12, 13].map(vid => ({ vid, event: 'in' as const })),
    });
    expect(hex(bytes)).toBe('00 01 02 00 04 00 0a 56 48 00 00 00 00');
  });

  it('starts a new vector when the VIDs are not consecutive', () => {
    const bytes = encodeMvrp({
      leaveAll: false,
      declarations: [{ vid: 10, event: 'joinIn' }, { vid: 20, event: 'lv' }],
    });
    expect(hex(bytes)).toBe('00 01 02 00 01 00 0a 24 00 01 00 14 b4 00 00 00 00');
  });

  it('puts LeaveAll in the VectorHeader, 1 * 8192 + NumberOfValues', () => {
    const bytes = encodeMvrp({ leaveAll: true, declarations: [{ vid: 5, event: 'joinMt' }] });
    expect(hex(bytes).startsWith('00 01 02 20 01 00 05')).toBe(true);
    expect(decodeMvrp(bytes)).toMatchObject({ ok: true, leaveAll: true });
  });

  it('round-trips a spread of declarations', () => {
    const declarations = [
      { vid: 1, event: 'new' as const }, { vid: 2, event: 'joinIn' as const }, { vid: 3, event: 'mt' as const },
      { vid: 100, event: 'lv' as const }, { vid: 4094, event: 'in' as const },
    ];
    expect(decodeMvrp(encodeMvrp({ leaveAll: false, declarations }))).toEqual({ ok: true, leaveAll: false, declarations });
  });

  it('increments FirstValue as an unsigned binary number', () => {
    expect(Array.from(incrementValue(Uint8Array.of(0x00, 0xff), 1))).toEqual([0x01, 0x00]);
  });
});

describe('10.8.3: parsing', () => {
  it('discards the PDU when the last VectorAttribute is incomplete', () => {
    const truncated = Uint8Array.of(0x00, 0x01, 0x02, 0x00, 0x04, 0x00, 0x0a, 0x4a);
    expect(decodeMrpdu(truncated).ok).toBe(false);
  });

  it('takes the physical end of the PDU for an EndMark when the last vector is whole', () => {
    const noEndMarks = Uint8Array.of(0x00, 0x01, 0x02, 0x00, 0x01, 0x00, 0x0a, 0x24);
    expect(decodeMvrp(noEndMarks)).toEqual({ ok: true, leaveAll: false, declarations: [{ vid: 10, event: 'joinIn' }] });
  });

  it('refuses a packed byte that would hold an AttributeEvent beyond 5', () => {
    expect(decodeMrpdu(Uint8Array.of(0, 1, 2, 0, 1, 0, 10, 250, 0, 0, 0, 0)).ok).toBe(false);
  });

  it('refuses to encode a VID above 4094 or the reserved AttributeType 0', () => {
    expect(() => encodeMvrp({ leaveAll: false, declarations: [{ vid: 4095, event: 'new' }] })).toThrow(RangeError);
    expect(() => encodeMrpdu({
      protocolVersion: 0,
      messages: [{ attributeType: 0, attributeLength: 2, vectors: [] }],
    })).toThrow(RangeError);
  });

  it('writes AttributeListLength only for applications that use it (not MVRP)', () => {
    const withLength = encodeMrpdu({
      protocolVersion: 0,
      messages: [{ attributeType: 1, attributeLength: 2, vectors: [{ leaveAll: false, firstValue: Uint8Array.of(0, 10), events: ['joinIn'] }] }],
    }, { attributeListLength: true });
    expect(hex(withLength)).toBe('00 01 02 00 07 00 01 00 0a 24 00 00 00 00');
  });
});

describe('11.2.3.1: MVRP constants', () => {
  it('uses EtherType 88-F5 and the two MVRP group addresses', () => {
    expect(MVRP_ETHERTYPE).toBe(0x88f5);
    expect(MVRP_CUSTOMER_ADDRESS).toBe('01:80:c2:00:00:21');
    expect(MVRP_PROVIDER_ADDRESS).toBe('01:80:c2:00:00:0d');
  });
});

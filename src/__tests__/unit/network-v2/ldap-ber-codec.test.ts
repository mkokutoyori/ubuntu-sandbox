/**
 * Real ASN.1 BER codec unit tests (RFC 4511 §5.1 / X.690 subset).
 * Pins byte-for-byte round-tripping since everything above this layer
 * (LdapMessage, LdapServer/Client) depends on it being correct.
 */
import { describe, it, expect } from 'vitest';
import {
  encodeTLV, parseTLV, parseAll, concat,
  encodeInteger, decodeInteger, encodeBoolean, decodeBoolean,
  encodeOctetString, decodeOctetString, encodeNull,
  encodeSequence, encodeSet, encodeContextPrimitive, encodeContextPrimitiveString,
  encodeContextConstructed, encodeApplication,
  UNIVERSAL_TAG,
} from '@/network/devices/windows/server/ad/ldap/Ber';

describe('BER — length encoding', () => {
  it('short form for length < 128', () => {
    const tlv = encodeOctetString('a'.repeat(10));
    expect(tlv[1]).toBe(10); // single length byte, no 0x80 bit
  });

  it('long form for length >= 128', () => {
    const tlv = encodeOctetString('a'.repeat(200));
    expect(tlv[1] & 0x80).toBe(0x80);
    const numLenBytes = tlv[1] & 0x7f;
    expect(numLenBytes).toBe(1); // 200 fits in a single length octet (0xC8)
    const parsed = parseTLV(tlv, 0);
    expect(parsed.content.length).toBe(200);
  });

  it('long form with a multi-byte length (> 255)', () => {
    const tlv = encodeOctetString('a'.repeat(300));
    const numLenBytes = tlv[1] & 0x7f;
    expect(numLenBytes).toBe(2); // 300 needs 2 length octets
    expect(parseTLV(tlv, 0).content.length).toBe(300);
  });
});

describe('BER — INTEGER', () => {
  const cases = [0, 1, 127, 128, 255, 256, 65535, 65536, 1000000, -1, -128, -129, -256, -1000000];
  for (const n of cases) {
    it(`round-trips ${n}`, () => {
      const encoded = encodeInteger(n);
      const parsed = parseTLV(encoded, 0);
      expect(parsed.tagClass).toBe('universal');
      expect(parsed.tagNumber).toBe(UNIVERSAL_TAG.INTEGER);
      expect(parsed.constructed).toBe(false);
      expect(decodeInteger(parsed.content)).toBe(n);
    });
  }

  it('minimal encoding: 127 is one byte, 128 needs two (sign disambiguation)', () => {
    expect(encodeInteger(127).length).toBe(2 + 1); // tag+len+1 content byte
    expect(encodeInteger(128).length).toBe(2 + 2); // tag+len+2 content bytes (0x00 0x80)
  });
});

describe('BER — BOOLEAN', () => {
  it('round-trips true/false', () => {
    expect(decodeBoolean(parseTLV(encodeBoolean(true), 0).content)).toBe(true);
    expect(decodeBoolean(parseTLV(encodeBoolean(false), 0).content)).toBe(false);
  });
});

describe('BER — OCTET STRING', () => {
  it('round-trips ASCII and UTF-8', () => {
    for (const s of ['', 'hello', 'CN=bob,CN=Users,DC=lab,DC=local', 'héllo wörld', 'a'.repeat(500)]) {
      const parsed = parseTLV(encodeOctetString(s), 0);
      expect(decodeOctetString(parsed.content)).toBe(s);
    }
  });
});

describe('BER — NULL', () => {
  it('encodes as tag+zero-length', () => {
    const tlv = encodeNull();
    expect(tlv.length).toBe(2);
    const parsed = parseTLV(tlv, 0);
    expect(parsed.tagNumber).toBe(UNIVERSAL_TAG.NULL);
    expect(parsed.content.length).toBe(0);
  });
});

describe('BER — SEQUENCE / SET nesting', () => {
  it('a SEQUENCE of INTEGER + OCTET STRING parses back both children in order', () => {
    const seq = encodeSequence([encodeInteger(42), encodeOctetString('hi')]);
    const outer = parseTLV(seq, 0);
    expect(outer.tagNumber).toBe(UNIVERSAL_TAG.SEQUENCE);
    expect(outer.constructed).toBe(true);
    const children = parseAll(outer.content);
    expect(children).toHaveLength(2);
    expect(decodeInteger(children[0].content)).toBe(42);
    expect(decodeOctetString(children[1].content)).toBe('hi');
  });

  it('a SET behaves the same but with the SET universal tag', () => {
    const set = encodeSet([encodeOctetString('x'), encodeOctetString('y')]);
    const outer = parseTLV(set, 0);
    expect(outer.tagNumber).toBe(UNIVERSAL_TAG.SET);
    const children = parseAll(outer.content);
    expect(children.map(c => decodeOctetString(c.content))).toEqual(['x', 'y']);
  });

  it('nested SEQUENCEs parse recursively', () => {
    const inner = encodeSequence([encodeInteger(1), encodeInteger(2)]);
    const outer = encodeSequence([encodeOctetString('outer'), inner]);
    const parsedOuter = parseAll(parseTLV(outer, 0).content);
    expect(decodeOctetString(parsedOuter[0].content)).toBe('outer');
    const parsedInner = parseAll(parsedOuter[1].content);
    expect(parsedInner.map(c => decodeInteger(c.content))).toEqual([1, 2]);
  });
});

describe('BER — context-specific and application tags', () => {
  it('context primitive (e.g. simple bind password [0])', () => {
    const tlv = encodeContextPrimitiveString(0, 'secret');
    const parsed = parseTLV(tlv, 0);
    expect(parsed.tagClass).toBe('context');
    expect(parsed.tagNumber).toBe(0);
    expect(parsed.constructed).toBe(false);
    expect(decodeOctetString(parsed.content)).toBe('secret');
  });

  it('context constructed (e.g. a filter CHOICE tag wrapping a SET)', () => {
    const tlv = encodeContextConstructed(0, [encodeOctetString('a'), encodeOctetString('b')]);
    const parsed = parseTLV(tlv, 0);
    expect(parsed.tagClass).toBe('context');
    expect(parsed.constructed).toBe(true);
    const children = parseAll(parsed.content);
    expect(children.map(c => decodeOctetString(c.content))).toEqual(['a', 'b']);
  });

  it('application tag (e.g. BindRequest [APPLICATION 0])', () => {
    const tlv = encodeApplication(0, true, concat([encodeInteger(3), encodeOctetString('cn=admin')]));
    const parsed = parseTLV(tlv, 0);
    expect(parsed.tagClass).toBe('application');
    expect(parsed.tagNumber).toBe(0);
    const children = parseAll(parsed.content);
    expect(decodeInteger(children[0].content)).toBe(3);
    expect(decodeOctetString(children[1].content)).toBe('cn=admin');
  });

  it('high tag numbers (>30) round-trip via the multi-byte tag form', () => {
    const tlv = encodeTLV('application', 31, false, new Uint8Array([1, 2, 3]));
    const parsed = parseTLV(tlv, 0);
    expect(parsed.tagNumber).toBe(31);
    expect([...parsed.content]).toEqual([1, 2, 3]);
  });
});

describe('BER — malformed input', () => {
  it('throws on truncated length', () => {
    expect(() => parseTLV(new Uint8Array([0x04, 0x85]), 0)).toThrow();
  });
  it('throws on truncated content', () => {
    expect(() => parseTLV(new Uint8Array([0x04, 0x05, 0x41]), 0)).toThrow();
  });
  it('throws on indefinite length (BER form LDAP forbids)', () => {
    expect(() => parseTLV(new Uint8Array([0x30, 0x80, 0x00, 0x00]), 0)).toThrow();
  });
});

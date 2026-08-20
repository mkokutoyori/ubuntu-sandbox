import { describe, it, expect } from 'vitest';
import { bytesToUtf8 } from '@/crypto/encoding';
import { attr, getAttr, getVsa, type RadiusPacket } from '@/network/radius/types';
import { encodeRadiusPacket, decodeRadiusPacket, isRadiusDecodeError } from '@/network/radius/codec';
import { CISCO_VENDOR_ID, MICROSOFT_VENDOR_ID } from '@/network/radius/dictionary';

const ZERO_AUTH = '00'.repeat(16);

describe('RADIUS codec — wire layout (RFC 2865 §3)', () => {
  it('encodes an Access-Request to the exact byte layout', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: 5,
      authenticator: ZERO_AUTH,
      attributes: [attr('user-name', 'alice'), attr('nas-ip-address', '10.0.0.1')],
    };
    const bytes = encodeRadiusPacket(packet);

    expect(bytes.length).toBe(33);
    expect(bytes[0]).toBe(1); // Code = Access-Request
    expect(bytes[1]).toBe(5); // Identifier
    expect((bytes[2] << 8) | bytes[3]).toBe(33); // Length
    expect(Array.from(bytes.subarray(4, 20))).toEqual(new Array(16).fill(0)); // Authenticator

    // User-Name (type 1)
    expect(bytes[20]).toBe(1);
    expect(bytes[21]).toBe(7); // 2 (type+length) + 5 ("alice")
    expect(bytesToUtf8(bytes.subarray(22, 27))).toBe('alice');

    // NAS-IP-Address (type 4)
    expect(bytes[27]).toBe(4);
    expect(bytes[28]).toBe(6); // 2 + 4 octets
    expect(Array.from(bytes.subarray(29, 33))).toEqual([10, 0, 0, 1]);
  });

  it('round-trips code, identifier and authenticator through encode/decode', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 200,
      authenticator: 'ab'.repeat(16),
      attributes: [attr('reply-message', 'Welcome')],
    };
    const decoded = decodeRadiusPacket(encodeRadiusPacket(packet));
    expect(isRadiusDecodeError(decoded)).toBe(false);
    if (isRadiusDecodeError(decoded)) return;
    expect(decoded.code).toBe('access-accept');
    expect(decoded.identifier).toBe(200);
    expect(decoded.authenticator).toBe('ab'.repeat(16));
    expect(decoded.raw?.length).toBe(encodeRadiusPacket(packet).length);
  });

  it('round-trips every standard value type', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: 1,
      authenticator: ZERO_AUTH,
      attributes: [
        attr('user-name', 'bob'),               // text
        attr('user-password', 'deadbeef'),       // string (opaque ciphertext, hex on the JS side)
        attr('nas-ip-address', '192.168.1.1'),   // address
        attr('nas-port', 42),                    // integer
        attr('event-timestamp', 1_700_000_000),  // time
        attr('state', 'aabbcc'),                 // octets
        attr('tunnel-type', 13),                 // tagged-integer (13 = VLAN)
        attr('tunnel-private-group-id', '100'),  // tagged-string
      ],
    };
    const decoded = decodeRadiusPacket(encodeRadiusPacket(packet));
    expect(isRadiusDecodeError(decoded)).toBe(false);
    if (isRadiusDecodeError(decoded)) return;

    expect(getAttr(decoded, 'user-name')?.value).toBe('bob');
    expect(getAttr(decoded, 'user-password')?.value).toBe('deadbeef');
    expect(getAttr(decoded, 'nas-ip-address')?.value).toBe('192.168.1.1');
    expect(getAttr(decoded, 'nas-port')?.value).toBe(42);
    expect(getAttr(decoded, 'event-timestamp')?.value).toBe(1_700_000_000);
    expect(getAttr(decoded, 'state')?.value).toBe('aabbcc');
    expect(getAttr(decoded, 'tunnel-type')?.value).toBe(13);
    expect(getAttr(decoded, 'tunnel-private-group-id')?.value).toBe('100');
  });

  it('round-trips a Cisco AV-pair VSA (shell:priv-lvl)', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 9,
      authenticator: ZERO_AUTH,
      attributes: [attr('vendor-specific', 'shell:priv-lvl=15', { id: CISCO_VENDOR_ID, type: 1 })],
    };
    const decoded = decodeRadiusPacket(encodeRadiusPacket(packet));
    expect(isRadiusDecodeError(decoded)).toBe(false);
    if (isRadiusDecodeError(decoded)) return;
    const vsa = getVsa(decoded, CISCO_VENDOR_ID, 1);
    expect(vsa?.value).toBe('shell:priv-lvl=15');
    expect(vsa?.vendor).toEqual({ id: CISCO_VENDOR_ID, type: 1 });
  });

  it('round-trips a Microsoft VSA (MS-MPPE-Recv-Key) as octets', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-accept', identifier: 9,
      authenticator: ZERO_AUTH,
      attributes: [attr('vendor-specific', 'aa11bb22', { id: MICROSOFT_VENDOR_ID, type: 17 })],
    };
    const decoded = decodeRadiusPacket(encodeRadiusPacket(packet));
    expect(isRadiusDecodeError(decoded)).toBe(false);
    if (isRadiusDecodeError(decoded)) return;
    const vsa = getVsa(decoded, MICROSOFT_VENDOR_ID, 17);
    expect(vsa?.value).toBe('aa11bb22');
  });

  it('skips an unrecognized attribute type instead of failing the whole packet', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: 1,
      authenticator: ZERO_AUTH,
      attributes: [attr('user-name', 'carol')],
    };
    const bytes = encodeRadiusPacket(packet);
    // Splice in a bogus attribute (type 250, unrecognized) right after the header.
    const bogus = Uint8Array.of(250, 4, 0xde, 0xad);
    const withBogus = new Uint8Array(bytes.length + bogus.length);
    withBogus.set(bytes.subarray(0, 20), 0);
    withBogus.set(bogus, 20);
    withBogus.set(bytes.subarray(20), 20 + bogus.length);
    // Fix up the length header for the spliced packet.
    const newLength = withBogus.length;
    withBogus[2] = (newLength >> 8) & 0xff;
    withBogus[3] = newLength & 0xff;

    const decoded = decodeRadiusPacket(withBogus);
    expect(isRadiusDecodeError(decoded)).toBe(false);
    if (isRadiusDecodeError(decoded)) return;
    expect(getAttr(decoded, 'user-name')?.value).toBe('carol');
    expect(decoded.attributes.length).toBe(1); // bogus type 250 was dropped, not an error
  });

  it('rejects a packet shorter than the minimum header size', () => {
    const result = decodeRadiusPacket(new Uint8Array(10));
    expect(isRadiusDecodeError(result)).toBe(true);
  });

  it('rejects an unknown RADIUS code', () => {
    const bytes = new Uint8Array(20);
    bytes[0] = 250; // not a defined code
    bytes[2] = 0; bytes[3] = 20;
    const result = decodeRadiusPacket(bytes);
    expect(isRadiusDecodeError(result)).toBe(true);
  });

  it('rejects a truncated attribute', () => {
    const bytes = new Uint8Array(23);
    bytes[0] = 1; bytes[1] = 1;
    bytes[2] = 0; bytes[3] = 23;
    bytes[20] = 1;  // attribute type
    bytes[21] = 10; // claims 10 bytes but only 1 remain
    const result = decodeRadiusPacket(bytes);
    expect(isRadiusDecodeError(result)).toBe(true);
  });

  it('refuses to encode an authenticator that is not 16 bytes', () => {
    const packet: RadiusPacket = {
      type: 'radius', code: 'access-request', identifier: 1,
      authenticator: 'ab', attributes: [],
    };
    expect(() => encodeRadiusPacket(packet)).toThrow();
  });
});

import { describe, it, expect } from 'vitest';
import { Rc4 } from '@/crypto/cipher';
import { bytesToHex, utf8ToBytes } from '@/crypto/encoding';

describe('Rc4 — published stream vectors', () => {
  it.each([
    ['Key', 'Plaintext', 'bbf316e8d940af0ad3'],
    ['Wiki', 'pedia', '1021bf0420'],
    ['Secret', 'Attack at dawn', '45a01f645fc35b383552544b9bf5'],
  ])('key %j encrypts %j', (key, plain, expected) => {
    expect(bytesToHex(new Rc4(utf8ToBytes(key)).process(utf8ToBytes(plain)))).toBe(expected);
  });

  it('produces the RFC 6229 keystream for the 40-bit key 0102030405', () => {
    const stream = new Rc4(new Uint8Array([1, 2, 3, 4, 5])).process(new Uint8Array(16));
    expect(bytesToHex(stream)).toBe('b2396305f03dc027ccc3524a0a1118a8');
  });

  it('continues the keystream across calls like one long message', () => {
    const whole = new Rc4(utf8ToBytes('Secret')).process(utf8ToBytes('Attack at dawn'));
    const cipher = new Rc4(utf8ToBytes('Secret'));
    const head = cipher.process(utf8ToBytes('Attack '));
    const tail = cipher.process(utf8ToBytes('at dawn'));
    expect(bytesToHex(new Uint8Array([...head, ...tail]))).toBe(bytesToHex(whole));
  });

  it('decrypts with a second instance of the same key', () => {
    const sealed = new Rc4(utf8ToBytes('k')).process(utf8ToBytes('round trip'));
    expect(new TextDecoder().decode(new Rc4(utf8ToBytes('k')).process(sealed))).toBe('round trip');
  });

  it('refuses an empty key', () => {
    expect(() => new Rc4(new Uint8Array(0))).toThrow();
  });
});

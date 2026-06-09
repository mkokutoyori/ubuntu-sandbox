/**
 * Cisco type-7 password encoding.
 *
 * Reversible XOR of each plaintext byte against a fixed 53-character vendor
 * key, offset by a per-secret salt. The ciphertext is `SS` (the 2-digit
 * decimal salt) followed by uppercase hex bytes. This is the real IOS format
 * for `password 7 …`; it provides obfuscation, not security.
 */

/** The fixed XLAT key baked into IOS (`vencode`). */
const TYPE7_KEY = 'dsfd;kfoA,.iyewrkldJKDHSUBsgvca69834ncxv9873254k;fg87';

/**
 * Encode `plaintext` as a type-7 string.
 *
 * @param salt  Key offset in [0, key length). Defaults to 0 for deterministic
 *              output (real IOS randomises it; the simulator favours stability).
 * @throws if the salt is outside the valid range.
 */
export function encryptType7(plaintext: string, salt = 0): string {
  if (!Number.isInteger(salt) || salt < 0 || salt >= TYPE7_KEY.length) {
    throw new Error(`encryptType7: salt ${salt} out of range [0, ${TYPE7_KEY.length})`);
  }
  let out = pad2(salt);
  for (let i = 0; i < plaintext.length; i++) {
    const cipherByte = (plaintext.charCodeAt(i) & 0xff) ^ keyByteAt(salt + i);
    out += cipherByte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/**
 * Decode a type-7 string back to plaintext.
 *
 * @throws if the salt prefix is missing, the payload length is odd, or a
 *         non-hex character is present — a malformed secret must not silently
 *         decode to garbage.
 */
export function decryptType7(ciphertext: string): string {
  if (ciphertext.length < 2) {
    throw new Error('decryptType7: ciphertext too short to contain a salt');
  }
  const salt = Number.parseInt(ciphertext.slice(0, 2), 10);
  if (Number.isNaN(salt) || salt < 0 || salt >= TYPE7_KEY.length) {
    throw new Error(`decryptType7: invalid salt prefix "${ciphertext.slice(0, 2)}"`);
  }
  const payload = ciphertext.slice(2);
  if (payload.length % 2 !== 0) {
    throw new Error('decryptType7: payload has an odd number of hex digits');
  }
  let out = '';
  for (let i = 0; i < payload.length; i += 2) {
    const byte = Number.parseInt(payload.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`decryptType7: invalid hex at offset ${i + 2}`);
    }
    out += String.fromCharCode(byte ^ keyByteAt(salt + i / 2));
  }
  return out;
}

const pad2 = (n: number): string => n.toString().padStart(2, '0');

/** Key byte at a logical position, wrapping around the fixed key. */
const keyByteAt = (pos: number): number =>
  TYPE7_KEY.charCodeAt(pos % TYPE7_KEY.length);

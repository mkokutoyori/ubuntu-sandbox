/**
 * Byte / encoding primitives shared by every hash and MAC implementation.
 *
 * All hashes operate on `Uint8Array` so they stay free of any string-encoding
 * assumptions. These helpers convert between the representations the simulator
 * actually deals with: UTF-8 text, hex digests, and base64 (SSH fingerprints).
 *
 * Environment-agnostic: works the same under the browser and the node test
 * runner (uses the Web `TextEncoder`/`TextDecoder`, available in both).
 */

const HEX_ALPHABET = '0123456789abcdef';
const BASE64_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a JavaScript string into its UTF-8 byte sequence. */
export function utf8ToBytes(text: string): Uint8Array {
  return textEncoder.encode(text);
}

/** Decode a UTF-8 byte sequence back into a JavaScript string. */
export function bytesToUtf8(bytes: Uint8Array): string {
  return textDecoder.decode(bytes);
}

/** Render bytes as a lowercase, zero-padded hexadecimal string. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out += HEX_ALPHABET[b >> 4] + HEX_ALPHABET[b & 0x0f];
  }
  return out;
}

/**
 * Parse a hexadecimal string into bytes. Accepts upper or lower case.
 *
 * @throws if the length is odd or a non-hex character is present — failing
 *         fast keeps a corrupt digest from silently becoming garbage bytes.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (length ${hex.length})`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: invalid hex at offset ${i * 2}`);
    }
    out[i] = byte;
  }
  return out;
}

/**
 * Decode an RFC 4648 base64 string into bytes. Trailing `=` padding is
 * optional. Throws on any character outside the standard alphabet so a
 * corrupt token fails fast rather than decoding to silent garbage.
 */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/=+$/, '');
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const idx = BASE64_ALPHABET.indexOf(clean[i]);
    if (idx === -1) {
      throw new Error(`base64ToBytes: invalid base64 character "${clean[i]}"`);
    }
    buffer = (buffer << 6) | idx;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** Standard RFC 4648 base64 encoding (with `=` padding). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = bytes[i];
    const b2 = bytes[i + 1];
    const b3 = bytes[i + 2];
    const hasB2 = i + 1 < bytes.length;
    const hasB3 = i + 2 < bytes.length;
    out += BASE64_ALPHABET[b1 >> 2];
    out += BASE64_ALPHABET[((b1 & 0x03) << 4) | (hasB2 ? b2 >> 4 : 0)];
    out += hasB2 ? BASE64_ALPHABET[((b2 & 0x0f) << 2) | (hasB3 ? b3 >> 6 : 0)] : '=';
    out += hasB3 ? BASE64_ALPHABET[b3 & 0x3f] : '=';
  }
  return out;
}

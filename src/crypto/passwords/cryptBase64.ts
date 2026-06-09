/**
 * crypt-style base64 with standard (RFC 4648) bit order but the crypt(3)
 * alphabet (`./0-9A-Za-z`) and no padding. Shared by Cisco type-8 and type-9,
 * which encode their derived keys this way.
 */

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Encode bytes to crypt base64 (no padding). */
export function cryptBase64(data: Uint8Array): string {
  let out = '';
  for (let i = 0; i < data.length; i += 3) {
    const b1 = data[i];
    const b2 = i + 1 < data.length ? data[i + 1] : 0;
    const b3 = i + 2 < data.length ? data[i + 2] : 0;
    out += ITOA64[b1 >> 2];
    out += ITOA64[((b1 & 0x03) << 4) | (b2 >> 4)];
    if (i + 1 < data.length) out += ITOA64[((b2 & 0x0f) << 2) | (b3 >> 6)];
    if (i + 2 < data.length) out += ITOA64[b3 & 0x3f];
  }
  return out;
}

/**
 * md5crypt — the "$1$" Unix crypt scheme (Poul-Henning Kamp, 1994).
 *
 * Built on the real MD5 in `@/crypto`. This is the algorithm behind Cisco
 * `secret 5` and Linux `$1$` shadow hashes. It is intentionally slow (1000
 * MD5 rounds) — a property the simulator must reproduce to emit authentic
 * hashes, even if it only ever displays them.
 */

import { md5 } from '../hash';
import { utf8ToBytes } from '../encoding';

const MAGIC = '$1$';
const MAX_SALT_LEN = 8;
/** crypt(3) base64 alphabet — note it starts with "./", unlike RFC 4648. */
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * Hash `password` with the given `salt` (truncated to 8 chars), returning a
 * full `$1$<salt>$<checksum>` modular crypt string.
 */
export function md5Crypt(password: string, salt: string): string {
  const saltStr = salt.slice(0, MAX_SALT_LEN);
  const pw = utf8ToBytes(password);
  const saltBytes = utf8ToBytes(saltStr);

  // Step 1: "alternate" digest of password+salt+password.
  const alt = md5(concat(pw, saltBytes, pw));

  // Step 2: primary digest of password + magic + salt + folded alt + length bits.
  const primary: number[] = [...pw, ...utf8ToBytes(MAGIC), ...saltBytes];
  for (let i = pw.length; i > 0; i -= 16) {
    push(primary, alt.subarray(0, Math.min(16, i)));
  }
  // For each bit of the password length, append a NUL or the first password byte.
  for (let i = pw.length; i !== 0; i >>>= 1) {
    primary.push(i & 1 ? 0 : pw[0] ?? 0);
  }
  let digest = md5(Uint8Array.from(primary));

  // Step 3: 1000 rounds of strengthening.
  for (let round = 0; round < 1000; round++) {
    const ctx: number[] = [];
    push(ctx, round & 1 ? pw : digest);
    if (round % 3 !== 0) push(ctx, saltBytes);
    if (round % 7 !== 0) push(ctx, pw);
    push(ctx, round & 1 ? digest : pw);
    digest = md5(Uint8Array.from(ctx));
  }

  return `${MAGIC}${saltStr}$${encode(digest)}`;
}

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

const push = (acc: number[], bytes: Uint8Array): void => {
  for (let i = 0; i < bytes.length; i++) acc.push(bytes[i]);
};

/** crypt-specific permuted base64 of the 16-byte digest → 22 chars. */
function encode(d: Uint8Array): string {
  let out = '';
  out += to64((d[0] << 16) | (d[6] << 8) | d[12], 4);
  out += to64((d[1] << 16) | (d[7] << 8) | d[13], 4);
  out += to64((d[2] << 16) | (d[8] << 8) | d[14], 4);
  out += to64((d[3] << 16) | (d[9] << 8) | d[15], 4);
  out += to64((d[4] << 16) | (d[10] << 8) | d[5], 4);
  out += to64(d[11], 2);
  return out;
}

/** Emit `n` base64 characters from `value`, least-significant 6 bits first. */
function to64(value: number, n: number): string {
  let out = '';
  let v = value;
  for (let i = 0; i < n; i++) {
    out += ITOA64[v & 0x3f];
    v >>>= 6;
  }
  return out;
}

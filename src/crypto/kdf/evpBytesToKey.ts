import { md5 } from '@/crypto/hash';

export function evpBytesToKey(password: Uint8Array, salt: Uint8Array, total: number): Uint8Array {
  const out = new Uint8Array(total);
  let filled = 0;
  let previous = new Uint8Array(0);
  while (filled < total) {
    const input = new Uint8Array(previous.length + password.length + salt.length);
    input.set(previous, 0);
    input.set(password, previous.length);
    input.set(salt, previous.length + password.length);
    previous = md5(input);
    const n = Math.min(previous.length, total - filled);
    out.set(previous.subarray(0, n), filled);
    filled += n;
  }
  return out;
}

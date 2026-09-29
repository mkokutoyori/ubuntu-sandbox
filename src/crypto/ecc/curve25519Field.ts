export const P25519 = (1n << 255n) - 19n;

export function mod25519(a: bigint): bigint {
  const r = a % P25519;
  return r < 0n ? r + P25519 : r;
}

export function pow25519(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod25519(base);
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) result = mod25519(result * b);
    b = mod25519(b * b);
    e >>= 1n;
  }
  return result;
}

export function invert25519(a: bigint): bigint {
  return pow25519(a, P25519 - 2n);
}

export function littleEndianToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

export function bigIntToLittleEndian(n: bigint, length = 32): Uint8Array {
  const out = new Uint8Array(length);
  let v = n;
  for (let i = 0; i < length; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}

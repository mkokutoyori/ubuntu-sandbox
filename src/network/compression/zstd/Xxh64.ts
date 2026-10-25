const MASK = (1n << 64n) - 1n;
const P1 = 11400714785074694791n;
const P2 = 14029467366897019727n;
const P3 = 1609587929392839161n;
const P4 = 9650029242287828579n;
const P5 = 2870177450012600261n;

const rotate = (value: bigint, bits: bigint): bigint => ((value << bits) | (value >> (64n - bits))) & MASK;

function read64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index]);
  return value;
}

function read32(bytes: Uint8Array, offset: number): bigint {
  return BigInt((bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0);
}

function round(accumulator: bigint, input: bigint): bigint {
  return (rotate((accumulator + input * P2) & MASK, 31n) * P1) & MASK;
}

function merge(accumulator: bigint, value: bigint): bigint {
  return (((accumulator ^ round(0n, value)) * P1) + P4) & MASK;
}

export function xxh64(bytes: Uint8Array, seed = 0n): bigint {
  const length = bytes.length;
  let offset = 0;
  let hash: bigint;
  if (length >= 32) {
    let v1 = (seed + P1 + P2) & MASK;
    let v2 = (seed + P2) & MASK;
    let v3 = seed & MASK;
    let v4 = (seed - P1) & MASK;
    while (offset + 32 <= length) {
      v1 = round(v1, read64(bytes, offset));
      v2 = round(v2, read64(bytes, offset + 8));
      v3 = round(v3, read64(bytes, offset + 16));
      v4 = round(v4, read64(bytes, offset + 24));
      offset += 32;
    }
    hash = (rotate(v1, 1n) + rotate(v2, 7n) + rotate(v3, 12n) + rotate(v4, 18n)) & MASK;
    hash = merge(hash, v1);
    hash = merge(hash, v2);
    hash = merge(hash, v3);
    hash = merge(hash, v4);
  } else {
    hash = (seed + P5) & MASK;
  }
  hash = (hash + BigInt(length)) & MASK;
  while (offset + 8 <= length) {
    hash ^= round(0n, read64(bytes, offset));
    hash = (rotate(hash, 27n) * P1 + P4) & MASK;
    offset += 8;
  }
  if (offset + 4 <= length) {
    hash ^= (read32(bytes, offset) * P1) & MASK;
    hash = (rotate(hash, 23n) * P2 + P3) & MASK;
    offset += 4;
  }
  while (offset < length) {
    hash ^= (BigInt(bytes[offset]) * P5) & MASK;
    hash = (rotate(hash, 11n) * P1) & MASK;
    offset++;
  }
  hash ^= hash >> 33n;
  hash = (hash * P2) & MASK;
  hash ^= hash >> 29n;
  hash = (hash * P3) & MASK;
  hash ^= hash >> 32n;
  return hash;
}

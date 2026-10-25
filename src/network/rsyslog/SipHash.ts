const MASK = (1n << 64n) - 1n;

function rotateLeft(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & MASK;
}

function readLittleEndian(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let index = 7; index >= 0; index--) value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  return value;
}

export function sipHash24(data: Uint8Array, key: Uint8Array): Uint8Array {
  let v0 = 0x736f6d6570736575n;
  let v1 = 0x646f72616e646f6dn;
  let v2 = 0x6c7967656e657261n;
  let v3 = 0x7465646279746573n;
  const k0 = readLittleEndian(key, 0);
  const k1 = readLittleEndian(key, 8);
  v3 ^= k1;
  v2 ^= k0;
  v1 ^= k1;
  v0 ^= k0;
  const round = (): void => {
    v0 = (v0 + v1) & MASK;
    v1 = rotateLeft(v1, 13n);
    v1 ^= v0;
    v0 = rotateLeft(v0, 32n);
    v2 = (v2 + v3) & MASK;
    v3 = rotateLeft(v3, 16n);
    v3 ^= v2;
    v0 = (v0 + v3) & MASK;
    v3 = rotateLeft(v3, 21n);
    v3 ^= v0;
    v2 = (v2 + v1) & MASK;
    v1 = rotateLeft(v1, 17n);
    v1 ^= v2;
    v2 = rotateLeft(v2, 32n);
  };
  const fullBlocks = Math.floor(data.length / 8) * 8;
  for (let offset = 0; offset < fullBlocks; offset += 8) {
    const block = readLittleEndian(data, offset);
    v3 ^= block;
    round();
    round();
    v0 ^= block;
  }
  let last = BigInt(data.length & 0xff) << 56n;
  for (let index = data.length - 1; index >= fullBlocks; index--) last |= BigInt(data[index]) << BigInt(8 * (index - fullBlocks));
  v3 ^= last;
  round();
  round();
  v0 ^= last;
  v2 ^= 0xffn;
  round();
  round();
  round();
  round();
  const digest = v0 ^ v1 ^ v2 ^ v3;
  const out = new Uint8Array(8);
  for (let index = 0; index < 8; index++) out[index] = Number((digest >> BigInt(8 * index)) & 0xffn);
  return out;
}

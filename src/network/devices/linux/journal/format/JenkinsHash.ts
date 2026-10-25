const rotate = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) >>> 0;

function word(bytes: Uint8Array, offset: number, available: number): number {
  let value = 0;
  for (let index = 0; index < Math.min(4, available); index++) value |= bytes[offset + index] << (8 * index);
  return value >>> 0;
}

export function jenkinsHashLittle2(bytes: Uint8Array, initialC: number, initialB: number): { readonly c: number; readonly b: number } {
  let a = (0xdeadbeef + bytes.length + initialC) >>> 0;
  let b = a;
  let c = (a + initialB) >>> 0;
  let offset = 0;
  let remaining = bytes.length;
  while (remaining > 12) {
    a = (a + word(bytes, offset, 4)) >>> 0;
    b = (b + word(bytes, offset + 4, 4)) >>> 0;
    c = (c + word(bytes, offset + 8, 4)) >>> 0;
    a = (a - c) >>> 0; a ^= rotate(c, 4); c = (c + b) >>> 0;
    b = (b - a) >>> 0; b ^= rotate(a, 6); a = (a + c) >>> 0;
    c = (c - b) >>> 0; c ^= rotate(b, 8); b = (b + a) >>> 0;
    a = (a - c) >>> 0; a ^= rotate(c, 16); c = (c + b) >>> 0;
    b = (b - a) >>> 0; b ^= rotate(a, 19); a = (a + c) >>> 0;
    c = (c - b) >>> 0; c ^= rotate(b, 4); b = (b + a) >>> 0;
    a >>>= 0; b >>>= 0; c >>>= 0;
    offset += 12;
    remaining -= 12;
  }
  if (remaining === 0) return { c, b };
  a = (a + word(bytes, offset, remaining)) >>> 0;
  if (remaining > 4) b = (b + word(bytes, offset + 4, remaining - 4)) >>> 0;
  if (remaining > 8) c = (c + word(bytes, offset + 8, remaining - 8)) >>> 0;
  c ^= b; c = (c - rotate(b, 14)) >>> 0;
  a ^= c; a = (a - rotate(c, 11)) >>> 0;
  b ^= a; b = (b - rotate(a, 25)) >>> 0;
  c ^= b; c = (c - rotate(b, 16)) >>> 0;
  a ^= c; a = (a - rotate(c, 4)) >>> 0;
  b ^= a; b = (b - rotate(a, 14)) >>> 0;
  c ^= b; c = (c - rotate(b, 24)) >>> 0;
  return { c: c >>> 0, b: b >>> 0 };
}

export function jenkinsHash64(bytes: Uint8Array): bigint {
  const { c, b } = jenkinsHashLittle2(bytes, 0, 0);
  return (BigInt(c) << 32n) | BigInt(b);
}

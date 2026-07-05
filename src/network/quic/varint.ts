// RFC 9000 §16 — variable-length integer encoding. The top 2 bits of the
// first byte select the encoded length: 00→1 byte (6 usable bits), 01→2
// bytes (14 bits), 10→4 bytes (30 bits), 11→8 bytes (62 bits). Values are
// accepted/returned as JS `number`, so the 8-byte form is only supported up
// to Number.MAX_SAFE_INTEGER (arithmetic done via BigInt to avoid the
// 32-bit truncation of JS's native bitwise operators).
export function encodeVarint(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0) throw new Error(`varint must be a non-negative integer, got ${value}`);

  if (value < 0x40) return new Uint8Array([value]);

  if (value < 0x4000) {
    return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
  }

  if (value < 0x40000000) {
    return new Uint8Array([
      0x80 | ((value >>> 24) & 0x3f), (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff,
    ]);
  }

  if (value > Number.MAX_SAFE_INTEGER) throw new Error(`varint value ${value} exceeds the safely representable range`);
  const bytes = new Uint8Array(8);
  let v = BigInt(value);
  for (let i = 7; i >= 0; i--) {
    bytes[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  bytes[0] |= 0xc0;
  return bytes;
}

export interface DecodedVarint {
  value: number;
  bytesConsumed: number;
}

const VARINT_LENGTH_BY_PREFIX = [1, 2, 4, 8];

export function decodeVarint(bytes: Uint8Array, offset = 0): DecodedVarint | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  const length = VARINT_LENGTH_BY_PREFIX[first >> 6];
  if (offset + length > bytes.length) return null;

  if (length === 1) return { value: first & 0x3f, bytesConsumed: 1 };
  if (length === 2) return { value: ((first & 0x3f) << 8) | bytes[offset + 1], bytesConsumed: 2 };

  if (length === 4) {
    const value = (first & 0x3f) * 2 ** 24 + bytes[offset + 1] * 2 ** 16 + bytes[offset + 2] * 2 ** 8 + bytes[offset + 3];
    return { value, bytesConsumed: 4 };
  }

  let v = BigInt(first & 0x3f);
  for (let i = 1; i < 8; i++) v = (v << 8n) | BigInt(bytes[offset + i]);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('decoded varint exceeds the safely representable range');
  return { value: Number(v), bytesConsumed: 8 };
}

function littleEndian32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8) | ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 3] ?? 0) << 24)) >>> 0;
}

export function sipHash24(data: Uint8Array, key: Uint8Array): Uint8Array {
  const k0l = littleEndian32(key, 0);
  const k0h = littleEndian32(key, 4);
  const k1l = littleEndian32(key, 8);
  const k1h = littleEndian32(key, 12);
  let v0l = (0x70736575 ^ k0l) >>> 0;
  let v0h = (0x736f6d65 ^ k0h) >>> 0;
  let v1l = (0x6e646f6d ^ k1l) >>> 0;
  let v1h = (0x646f7261 ^ k1h) >>> 0;
  let v2l = (0x6e657261 ^ k0l) >>> 0;
  let v2h = (0x6c796765 ^ k0h) >>> 0;
  let v3l = (0x79746573 ^ k1l) >>> 0;
  let v3h = (0x74656462 ^ k1h) >>> 0;

  const round = (): void => {
    let low = v0l + v1l;
    v0h = (v0h + v1h + (low > 0xffffffff ? 1 : 0)) >>> 0;
    v0l = low >>> 0;
    let rotatedHigh = ((v1h << 13) | (v1l >>> 19)) >>> 0;
    v1l = ((v1l << 13) | (v1h >>> 19)) >>> 0;
    v1h = rotatedHigh;
    v1l = (v1l ^ v0l) >>> 0;
    v1h = (v1h ^ v0h) >>> 0;
    rotatedHigh = v0l;
    v0l = v0h;
    v0h = rotatedHigh;

    low = v2l + v3l;
    v2h = (v2h + v3h + (low > 0xffffffff ? 1 : 0)) >>> 0;
    v2l = low >>> 0;
    rotatedHigh = ((v3h << 16) | (v3l >>> 16)) >>> 0;
    v3l = ((v3l << 16) | (v3h >>> 16)) >>> 0;
    v3h = rotatedHigh;
    v3l = (v3l ^ v2l) >>> 0;
    v3h = (v3h ^ v2h) >>> 0;

    low = v0l + v3l;
    v0h = (v0h + v3h + (low > 0xffffffff ? 1 : 0)) >>> 0;
    v0l = low >>> 0;
    rotatedHigh = ((v3h << 21) | (v3l >>> 11)) >>> 0;
    v3l = ((v3l << 21) | (v3h >>> 11)) >>> 0;
    v3h = rotatedHigh;
    v3l = (v3l ^ v0l) >>> 0;
    v3h = (v3h ^ v0h) >>> 0;

    low = v2l + v1l;
    v2h = (v2h + v1h + (low > 0xffffffff ? 1 : 0)) >>> 0;
    v2l = low >>> 0;
    rotatedHigh = ((v1h << 17) | (v1l >>> 15)) >>> 0;
    v1l = ((v1l << 17) | (v1h >>> 15)) >>> 0;
    v1h = rotatedHigh;
    v1l = (v1l ^ v2l) >>> 0;
    v1h = (v1h ^ v2h) >>> 0;
    rotatedHigh = v2l;
    v2l = v2h;
    v2h = rotatedHigh;
  };

  const fullBlocks = Math.floor(data.length / 8) * 8;
  for (let offset = 0; offset < fullBlocks; offset += 8) {
    const blockLow = littleEndian32(data, offset);
    const blockHigh = littleEndian32(data, offset + 4);
    v3l = (v3l ^ blockLow) >>> 0;
    v3h = (v3h ^ blockHigh) >>> 0;
    round();
    round();
    v0l = (v0l ^ blockLow) >>> 0;
    v0h = (v0h ^ blockHigh) >>> 0;
  }

  let lastLow = 0;
  let lastHigh = (data.length & 0xff) << 24;
  for (let index = data.length - 1; index >= fullBlocks; index--) {
    const position = index - fullBlocks;
    if (position < 4) lastLow |= data[index] << (8 * position);
    else lastHigh |= data[index] << (8 * (position - 4));
  }
  lastLow >>>= 0;
  lastHigh >>>= 0;
  v3l = (v3l ^ lastLow) >>> 0;
  v3h = (v3h ^ lastHigh) >>> 0;
  round();
  round();
  v0l = (v0l ^ lastLow) >>> 0;
  v0h = (v0h ^ lastHigh) >>> 0;
  v2l = (v2l ^ 0xff) >>> 0;
  round();
  round();
  round();
  round();

  const digestLow = (v0l ^ v1l ^ v2l ^ v3l) >>> 0;
  const digestHigh = (v0h ^ v1h ^ v2h ^ v3h) >>> 0;
  const out = new Uint8Array(8);
  for (let index = 0; index < 4; index++) {
    out[index] = (digestLow >>> (8 * index)) & 0xff;
    out[index + 4] = (digestHigh >>> (8 * index)) & 0xff;
  }
  return out;
}

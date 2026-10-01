const ROUNDS = 20;
export const CHACHA20_POLY1305_TAG_SIZE = 16;
export const CHACHA20_KEY_SIZE = 32;
export const CHACHA20_NONCE_SIZE = 12;

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

function quarterRound(state: Uint32Array, a: number, b: number, c: number, d: number): void {
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotl(state[d] ^ state[a], 16);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotl(state[b] ^ state[c], 12);
  state[a] = (state[a] + state[b]) >>> 0; state[d] = rotl(state[d] ^ state[a], 8);
  state[c] = (state[c] + state[d]) >>> 0; state[b] = rotl(state[b] ^ state[c], 7);
}

function readWordLe(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

export function chacha20Block(key: Uint8Array, counter: number, nonce: Uint8Array): Uint8Array {
  if (key.length !== CHACHA20_KEY_SIZE) throw new RangeError('ChaCha20: key must be 32 bytes');
  if (nonce.length !== CHACHA20_NONCE_SIZE) throw new RangeError('ChaCha20: nonce must be 12 bytes');
  const initial = new Uint32Array(16);
  initial[0] = 0x61707865; initial[1] = 0x3320646e; initial[2] = 0x79622d32; initial[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) initial[4 + i] = readWordLe(key, i * 4);
  initial[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) initial[13 + i] = readWordLe(nonce, i * 4);
  const state = Uint32Array.from(initial);
  for (let round = 0; round < ROUNDS; round += 2) {
    quarterRound(state, 0, 4, 8, 12); quarterRound(state, 1, 5, 9, 13);
    quarterRound(state, 2, 6, 10, 14); quarterRound(state, 3, 7, 11, 15);
    quarterRound(state, 0, 5, 10, 15); quarterRound(state, 1, 6, 11, 12);
    quarterRound(state, 2, 7, 8, 13); quarterRound(state, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const word = (state[i] + initial[i]) >>> 0;
    out[i * 4] = word & 0xff; out[i * 4 + 1] = (word >>> 8) & 0xff;
    out[i * 4 + 2] = (word >>> 16) & 0xff; out[i * 4 + 3] = (word >>> 24) & 0xff;
  }
  return out;
}

export function chacha20Xor(key: Uint8Array, counter: number, nonce: Uint8Array, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += 64) {
    const block = chacha20Block(key, counter + offset / 64, nonce);
    const take = Math.min(64, data.length - offset);
    for (let i = 0; i < take; i++) out[offset + i] = data[offset + i] ^ block[i];
  }
  return out;
}

const POLY_P = (1n << 130n) - 5n;
const POLY_R_CLAMP = 0x0ffffffc0ffffffc0ffffffc0fffffffn;

function leToBig(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);
  return value;
}

export function poly1305(key: Uint8Array, message: Uint8Array): Uint8Array {
  const r = leToBig(key.subarray(0, 16)) & POLY_R_CLAMP;
  const s = leToBig(key.subarray(16, 32));
  let accumulator = 0n;
  for (let offset = 0; offset < message.length; offset += 16) {
    const block = message.subarray(offset, Math.min(offset + 16, message.length));
    const n = leToBig(block) | (1n << BigInt(block.length * 8));
    accumulator = ((accumulator + n) * r) % POLY_P;
  }
  const tag = (accumulator + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = Number((tag >> BigInt(8 * i)) & 0xffn);
  return out;
}

function pad16(length: number): Uint8Array {
  return new Uint8Array((16 - (length % 16)) % 16);
}

function lengthBlock(aadLength: number, ciphertextLength: number): Uint8Array {
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  view.setUint32(0, aadLength, true);
  view.setUint32(8, ciphertextLength, true);
  return out;
}

function macData(aad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const padAad = pad16(aad.length);
  const padCt = pad16(ciphertext.length);
  const out = new Uint8Array(aad.length + padAad.length + ciphertext.length + padCt.length + 16);
  let offset = 0;
  out.set(aad, offset); offset += aad.length + padAad.length;
  out.set(ciphertext, offset); offset += ciphertext.length + padCt.length;
  out.set(lengthBlock(aad.length, ciphertext.length), offset);
  return out;
}

function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function chacha20Poly1305Encrypt(
  key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array,
): { ciphertext: Uint8Array; tag: Uint8Array } {
  const polyKey = chacha20Block(key, 0, nonce).subarray(0, 32);
  const ciphertext = chacha20Xor(key, 1, nonce, plaintext);
  return { ciphertext, tag: poly1305(polyKey, macData(aad, ciphertext)) };
}

export function chacha20Poly1305Decrypt(
  key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ciphertext: Uint8Array, tag: Uint8Array,
): Uint8Array | null {
  const polyKey = chacha20Block(key, 0, nonce).subarray(0, 32);
  if (!constantTimeEqual(poly1305(polyKey, macData(aad, ciphertext)), tag)) return null;
  return chacha20Xor(key, 1, nonce, ciphertext);
}

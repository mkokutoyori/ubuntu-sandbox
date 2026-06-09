/**
 * AES (FIPS-197) block cipher — dependency-free, byte-oriented implementation.
 *
 * Supports 128/192/256-bit keys. The S-box and round constants are derived
 * once from the GF(2^8) definitions at module load, so there are no opaque
 * hardcoded tables to mistranscribe. State is column-major per FIPS-197
 * (state[r + 4c]). Operates on `Uint8Array`; inputs are never mutated.
 */

const BLOCK_SIZE = 16;

// ─── GF(2^8) and the S-box, built from first principles ──────────────────

/** Multiply two bytes in GF(2^8) modulo the AES polynomial 0x11b. */
function gmul(a: number, b: number): number {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(function buildSbox() {
  const rotl8 = (x: number, s: number) => ((x << s) | (x >> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= (q << 1) & 0xff;
    q ^= (q << 2) & 0xff;
    q ^= (q << 4) & 0xff;
    if (q & 0x80) q ^= 0x09;
    q &= 0xff;
    SBOX[p] = (q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV_SBOX[SBOX[i]] = i;
})();

const RCON = new Uint8Array(11);
(function buildRcon() {
  let c = 1;
  for (let i = 1; i <= 10; i++) {
    RCON[i] = c;
    c = gmul(c, 2);
  }
})();

// ─── Key schedule ─────────────────────────────────────────────────────────

interface AesKey {
  readonly roundKeys: Uint8Array; // 16 * (Nr + 1) bytes
  readonly rounds: number;
}

function expandKey(key: Uint8Array): AesKey {
  const Nk = key.length / 4;
  if (Nk !== 4 && Nk !== 6 && Nk !== 8) {
    throw new Error(`AES: key must be 16, 24 or 32 bytes (got ${key.length})`);
  }
  const Nr = Nk + 6;
  const total = 4 * (Nr + 1); // number of 4-byte words
  const w = new Uint8Array(total * 4);
  w.set(key);

  const tmp = new Uint8Array(4);
  for (let i = Nk; i < total; i++) {
    tmp.set(w.subarray((i - 1) * 4, i * 4));
    if (i % Nk === 0) {
      // RotWord + SubWord + Rcon
      const t0 = tmp[0];
      tmp[0] = SBOX[tmp[1]] ^ RCON[i / Nk];
      tmp[1] = SBOX[tmp[2]];
      tmp[2] = SBOX[tmp[3]];
      tmp[3] = SBOX[t0];
    } else if (Nk > 6 && i % Nk === 4) {
      for (let k = 0; k < 4; k++) tmp[k] = SBOX[tmp[k]];
    }
    for (let k = 0; k < 4; k++) {
      w[i * 4 + k] = w[(i - Nk) * 4 + k] ^ tmp[k];
    }
  }
  return { roundKeys: w, rounds: Nr };
}

// ─── Round transformations ─────────────────────────────────────────────────

function addRoundKey(s: Uint8Array, w: Uint8Array, round: number): void {
  for (let i = 0; i < 16; i++) s[i] ^= w[round * 16 + i];
}

function shiftRows(s: Uint8Array): void {
  // Row r (bytes at r, r+4, r+8, r+12) rotates left by r.
  for (let r = 1; r < 4; r++) {
    const row = [s[r], s[r + 4], s[r + 8], s[r + 12]];
    for (let c = 0; c < 4; c++) s[r + 4 * c] = row[(c + r) % 4];
  }
}

function invShiftRows(s: Uint8Array): void {
  for (let r = 1; r < 4; r++) {
    const row = [s[r], s[r + 4], s[r + 8], s[r + 12]];
    for (let c = 0; c < 4; c++) s[r + 4 * c] = row[(c - r + 4) % 4];
  }
}

function mixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
    s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
    s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
    s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
  }
}

function invMixColumns(s: Uint8Array): void {
  for (let c = 0; c < 4; c++) {
    const i = c * 4;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    s[i] = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
    s[i + 1] = gmul(a0, 9) ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
    s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9) ^ gmul(a2, 14) ^ gmul(a3, 11);
    s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9) ^ gmul(a3, 14);
  }
}

// ─── Public block API ───────────────────────────────────────────────────────

/** Encrypt a single 16-byte block under `key` (128/192/256-bit). */
export function aesEncryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== BLOCK_SIZE) throw new Error(`AES: block must be 16 bytes (got ${block.length})`);
  const { roundKeys: w, rounds: Nr } = expandKey(key);
  const s = Uint8Array.from(block);
  addRoundKey(s, w, 0);
  for (let round = 1; round < Nr; round++) {
    subBytes(s, SBOX);
    shiftRows(s);
    mixColumns(s);
    addRoundKey(s, w, round);
  }
  subBytes(s, SBOX);
  shiftRows(s);
  addRoundKey(s, w, Nr);
  return s;
}

/** Decrypt a single 16-byte block under `key`. */
export function aesDecryptBlock(key: Uint8Array, block: Uint8Array): Uint8Array {
  if (block.length !== BLOCK_SIZE) throw new Error(`AES: block must be 16 bytes (got ${block.length})`);
  const { roundKeys: w, rounds: Nr } = expandKey(key);
  const s = Uint8Array.from(block);
  addRoundKey(s, w, Nr);
  for (let round = Nr - 1; round >= 1; round--) {
    invShiftRows(s);
    subBytes(s, INV_SBOX);
    addRoundKey(s, w, round);
    invMixColumns(s);
  }
  invShiftRows(s);
  subBytes(s, INV_SBOX);
  addRoundKey(s, w, 0);
  return s;
}

function subBytes(s: Uint8Array, box: Uint8Array): void {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]];
}

export const AES_BLOCK_SIZE = BLOCK_SIZE;

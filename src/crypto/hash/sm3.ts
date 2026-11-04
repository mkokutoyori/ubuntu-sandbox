const rotl = (value: number, bits: number): number => ((value << (bits % 32)) | (value >>> (32 - (bits % 32)))) >>> 0;
const p0 = (x: number): number => (x ^ rotl(x, 9) ^ rotl(x, 17)) >>> 0;
const p1 = (x: number): number => (x ^ rotl(x, 15) ^ rotl(x, 23)) >>> 0;

const IV = [0x7380166f, 0x4914b2b9, 0x172442d7, 0xda8a0600, 0xa96f30bc, 0x163138aa, 0xe38dee4d, 0xb0fb0e4e];

function pad(input: Uint8Array): Uint8Array {
  const bitLength = BigInt(input.length) * 8n;
  const padded = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  padded.set(input);
  padded[input.length] = 0x80;
  for (let byte = 0; byte < 8; byte++) padded[padded.length - 1 - byte] = Number((bitLength >> BigInt(8 * byte)) & 0xffn);
  return padded;
}

export function sm3(input: Uint8Array): Uint8Array {
  const state = [...IV];
  const padded = pad(input);
  for (let at = 0; at < padded.length; at += 64) {
    const w: number[] = new Array(68);
    for (let index = 0; index < 16; index++) {
      w[index] = ((padded[at + index * 4] << 24) | (padded[at + index * 4 + 1] << 16) | (padded[at + index * 4 + 2] << 8) | padded[at + index * 4 + 3]) >>> 0;
    }
    for (let index = 16; index < 68; index++) {
      w[index] = (p1((w[index - 16] ^ w[index - 9] ^ rotl(w[index - 3], 15)) >>> 0) ^ rotl(w[index - 13], 7) ^ w[index - 6]) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let j = 0; j < 64; j++) {
      const t = j < 16 ? 0x79cc4519 : 0x7a879d8a;
      const ss1 = rotl((rotl(a, 12) + e + rotl(t, j)) >>> 0, 7);
      const ss2 = (ss1 ^ rotl(a, 12)) >>> 0;
      const ff = j < 16 ? (a ^ b ^ c) >>> 0 : ((a & b) | (a & c) | (b & c)) >>> 0;
      const gg = j < 16 ? (e ^ f ^ g) >>> 0 : ((e & f) | (~e & g)) >>> 0;
      const tt1 = (ff + d + ss2 + (w[j] ^ w[j + 4])) >>> 0;
      const tt2 = (gg + h + ss1 + w[j]) >>> 0;
      d = c; c = rotl(b, 9); b = a; a = tt1;
      h = g; g = rotl(f, 19); f = e; e = p0(tt2);
    }
    const next = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index++) state[index] = (state[index] ^ next[index]) >>> 0;
  }
  const out = new Uint8Array(32);
  state.forEach((word, index) => { out[index * 4] = word >>> 24; out[index * 4 + 1] = (word >>> 16) & 255; out[index * 4 + 2] = (word >>> 8) & 255; out[index * 4 + 3] = word & 255; });
  return out;
}

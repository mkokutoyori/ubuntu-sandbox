import { Blowfish } from '../cipher/blowfish';
import { sha512 } from '../hash/sha512';
import { utf8ToBytes } from '../encoding';

const HASH_SIZE = 32;
const BLOCK_WORDS = 8;
const MAGIC = utf8ToBytes('OxychromaticBlowfishSwatDynamite');
const HASH_ROUNDS = 64;

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function bcryptHash(sha2pass: Uint8Array, sha2salt: Uint8Array): Uint8Array {
  const state = new Blowfish();
  state.expandState(sha2salt, sha2pass);
  for (let i = 0; i < HASH_ROUNDS; i++) {
    state.expandZeroState(sha2salt);
    state.expandZeroState(sha2pass);
  }
  const words = new Uint32Array(BLOCK_WORDS);
  const cursor = { at: 0 };
  for (let i = 0; i < BLOCK_WORDS; i++) words[i] = Blowfish.streamWord(MAGIC, cursor);
  for (let round = 0; round < HASH_ROUNDS; round++) {
    for (let i = 0; i < BLOCK_WORDS; i += 2) state.encipher(words, i);
  }
  const out = new Uint8Array(HASH_SIZE);
  for (let i = 0; i < BLOCK_WORDS; i++) {
    out[4 * i + 3] = words[i] >>> 24;
    out[4 * i + 2] = (words[i] >>> 16) & 0xff;
    out[4 * i + 1] = (words[i] >>> 8) & 0xff;
    out[4 * i] = words[i] & 0xff;
  }
  return out;
}

export function bcryptPbkdf(password: Uint8Array, salt: Uint8Array, keyLength: number, rounds: number): Uint8Array {
  if (rounds < 1 || keyLength < 1 || password.length === 0 || salt.length === 0) {
    throw new RangeError('bcrypt_pbkdf: invalid parameters');
  }
  const sha2pass = sha512(password);
  const stride = Math.floor((keyLength + HASH_SIZE - 1) / HASH_SIZE);
  const amount = Math.floor((keyLength + stride - 1) / stride);
  const key = new Uint8Array(keyLength);
  let remaining = keyLength;
  for (let count = 1; remaining > 0; count++) {
    const counter = new Uint8Array([(count >>> 24) & 0xff, (count >>> 16) & 0xff, (count >>> 8) & 0xff, count & 0xff]);
    let tmp = bcryptHash(sha2pass, sha512(concatBytes(salt, counter)));
    const out = tmp.slice();
    for (let i = 1; i < rounds; i++) {
      tmp = bcryptHash(sha2pass, sha512(tmp));
      for (let j = 0; j < HASH_SIZE; j++) out[j] ^= tmp[j];
    }
    const take = Math.min(amount, remaining);
    let used = 0;
    for (let i = 0; i < take; i++) {
      const dest = i * stride + (count - 1);
      if (dest >= keyLength) break;
      key[dest] = out[i];
      used += 1;
    }
    remaining -= used;
  }
  return key;
}

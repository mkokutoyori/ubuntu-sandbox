import { aesEncryptBlock, AES_BLOCK_SIZE } from './aes';
import { aesCmac, doubleBlock } from '../mac/aesCmac';

export const AES_SIV_TAG_SIZE = 16;

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function s2v(key: Uint8Array, strings: readonly Uint8Array[]): Uint8Array {
  if (strings.length === 0) {
    const one = new Uint8Array(AES_BLOCK_SIZE);
    one[AES_BLOCK_SIZE - 1] = 1;
    return aesCmac(key, one);
  }
  let d = aesCmac(key, new Uint8Array(AES_BLOCK_SIZE));
  for (let i = 0; i < strings.length - 1; i++) d = xor(doubleBlock(d), aesCmac(key, strings[i]));
  const last = strings[strings.length - 1];
  let t: Uint8Array;
  if (last.length >= AES_BLOCK_SIZE) {
    t = last.slice();
    const offset = last.length - AES_BLOCK_SIZE;
    for (let i = 0; i < AES_BLOCK_SIZE; i++) t[offset + i] ^= d[i];
  } else {
    const padded = new Uint8Array(AES_BLOCK_SIZE);
    padded.set(last);
    padded[last.length] = 0x80;
    t = xor(doubleBlock(d), padded);
  }
  return aesCmac(key, t);
}

function ctr(key: Uint8Array, initial: Uint8Array, data: Uint8Array): Uint8Array {
  const counter = initial.slice();
  const out = new Uint8Array(data.length);
  for (let offset = 0; offset < data.length; offset += AES_BLOCK_SIZE) {
    const stream = aesEncryptBlock(key, counter);
    const end = Math.min(AES_BLOCK_SIZE, data.length - offset);
    for (let i = 0; i < end; i++) out[offset + i] = data[offset + i] ^ stream[i];
    for (let i = AES_BLOCK_SIZE - 1; i >= 0; i--) {
      counter[i] = (counter[i] + 1) & 0xff;
      if (counter[i] !== 0) break;
    }
  }
  return out;
}

function counterStart(tag: Uint8Array): Uint8Array {
  const q = tag.slice();
  q[8] &= 0x7f;
  q[12] &= 0x7f;
  return q;
}

function splitKey(key: Uint8Array): [Uint8Array, Uint8Array] {
  if (key.length !== 32 && key.length !== 48 && key.length !== 64) throw new RangeError('AES-SIV: key must be 256, 384 or 512 bits');
  const half = key.length / 2;
  return [key.subarray(0, half), key.subarray(half)];
}

export function aesSivEncrypt(key: Uint8Array, associatedData: readonly Uint8Array[], plaintext: Uint8Array): Uint8Array {
  const [macKey, ctrKey] = splitKey(key);
  const tag = s2v(macKey, [...associatedData, plaintext]);
  const body = ctr(ctrKey, counterStart(tag), plaintext);
  const out = new Uint8Array(AES_SIV_TAG_SIZE + body.length);
  out.set(tag);
  out.set(body, AES_SIV_TAG_SIZE);
  return out;
}

export function aesSivDecrypt(key: Uint8Array, associatedData: readonly Uint8Array[], sealed: Uint8Array): Uint8Array | null {
  if (sealed.length < AES_SIV_TAG_SIZE) return null;
  const [macKey, ctrKey] = splitKey(key);
  const tag = sealed.subarray(0, AES_SIV_TAG_SIZE);
  const plaintext = ctr(ctrKey, counterStart(tag), sealed.subarray(AES_SIV_TAG_SIZE));
  const expected = s2v(macKey, [...associatedData, plaintext]);
  let diff = 0;
  for (let i = 0; i < AES_SIV_TAG_SIZE; i++) diff |= expected[i] ^ tag[i];
  return diff === 0 ? plaintext : null;
}

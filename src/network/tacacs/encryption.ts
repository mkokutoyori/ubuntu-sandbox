import { md5 } from '@/crypto/hash';
import { bytesToHex, bytesToUtf8, hexToBytes, utf8ToBytes } from '@/crypto/encoding';

function makePad(sessionId: number, secret: string, version: number, seqNo: number, length: number): Uint8Array {
  const sid = new Uint8Array(4);
  new DataView(sid.buffer).setUint32(0, sessionId >>> 0, false);
  const secretBytes = utf8ToBytes(secret);
  const tail = new Uint8Array([version & 0xff, seqNo & 0xff]);
  const seed = new Uint8Array(sid.length + secretBytes.length + tail.length);
  seed.set(sid, 0);
  seed.set(secretBytes, sid.length);
  seed.set(tail, sid.length + secretBytes.length);

  const blocks = Math.max(1, Math.ceil(length / 16));
  const pad = new Uint8Array(blocks * 16);
  let prev: Uint8Array | null = null;
  for (let off = 0; off < pad.length; off += 16) {
    const input = prev === null
      ? seed
      : (() => {
        const x = new Uint8Array(seed.length + prev.length);
        x.set(seed, 0);
        x.set(prev, seed.length);
        return x;
      })();
    const block = md5(input);
    pad.set(block, off);
    prev = block;
  }
  return pad.subarray(0, length);
}

export function encryptBody(bodyJson: string, sessionId: number, secret: string, version: number, seqNo: number): string {
  const plain = utf8ToBytes(bodyJson);
  const pad = makePad(sessionId, secret, version, seqNo, plain.length);
  const cipher = new Uint8Array(plain.length);
  for (let i = 0; i < plain.length; i++) cipher[i] = plain[i] ^ pad[i];
  return bytesToHex(cipher);
}

export function decryptBody(cipherHex: string, sessionId: number, secret: string, version: number, seqNo: number): string | null {
  let cipher: Uint8Array;
  try {
    cipher = hexToBytes(cipherHex);
  } catch {
    return null;
  }
  const pad = makePad(sessionId, secret, version, seqNo, cipher.length);
  const plain = new Uint8Array(cipher.length);
  for (let i = 0; i < cipher.length; i++) plain[i] = cipher[i] ^ pad[i];
  try {
    return bytesToUtf8(plain);
  } catch {
    return null;
  }
}

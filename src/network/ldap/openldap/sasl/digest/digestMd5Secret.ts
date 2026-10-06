import { md5 } from '@/crypto/hash/md5';

const COLON = 0x3a;
const HEX = '0123456789abcdef';

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += HEX[byte >> 4] + HEX[byte & 15];
  return out;
}

function inLatin1(bytes: Uint8Array): boolean {
  let scan = 0;
  for (; scan < bytes.length; scan++) {
    if (bytes[scan] > 0xc3) break;
    if (bytes[scan] >= 0xc0 && bytes[scan] <= 0xc3) {
      scan++;
      if (scan === bytes.length || bytes[scan] < 0x80 || bytes[scan] > 0xbf) break;
    }
  }
  return scan >= bytes.length;
}

function toLatin1Bytes(bytes: Uint8Array): number[] {
  const out: number[] = [];
  let base = 0;
  do {
    let scan = base;
    while (scan < bytes.length && bytes[scan] < 0xc0) scan++;
    for (let index = base; index < scan; index++) out.push(bytes[index]);
    if (scan + 1 >= bytes.length) break;
    out.push(((bytes[scan] & 0x3) << 6) | (bytes[scan + 1] & 0x3f));
    base = scan + 2;
  } while (base < bytes.length);
  return out;
}

function appendUtf8(out: number[], bytes: Uint8Array): void {
  const converted = inLatin1(bytes) ? toLatin1Bytes(bytes) : Array.from(bytes);
  for (const byte of converted) out.push(byte);
}

export function digestSecret(userName: Uint8Array, realm: Uint8Array | null, password: Uint8Array): Uint8Array {
  const input: number[] = [];
  appendUtf8(input, userName);
  input.push(COLON);
  if (realm !== null && realm.length > 0) appendUtf8(input, realm);
  input.push(COLON);
  appendUtf8(input, password);
  return md5(Uint8Array.from(input));
}

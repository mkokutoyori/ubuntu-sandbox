import { bytesToBinaryString, fileTextToBytes } from '@/crypto/encoding';

export function latin1Text(bytes: Uint8Array): string {
  return bytesToBinaryString(bytes);
}

export function latin1Bytes(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code > 0xff) return fileTextToBytes(text);
    bytes[index] = code;
  }
  return bytes;
}

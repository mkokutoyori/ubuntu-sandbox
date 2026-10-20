import { deflateSync } from 'node:zlib';

export function zlibCompressSync(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(Buffer.from(bytes)));
}

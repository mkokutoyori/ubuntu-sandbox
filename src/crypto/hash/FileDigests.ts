import { bytesToHex } from '../encoding';
import { md4 } from './md4';
import { md5 } from './md5';
import { sha1 } from './sha1';
import { sha256 } from './sha256';
import { sha384, sha512 } from './sha512';

export type FileDigestName = 'MD4' | 'MD5' | 'SHA1' | 'SHA256' | 'SHA384' | 'SHA512';

const DIGESTS: Readonly<Record<FileDigestName, (input: Uint8Array) => Uint8Array>> = {
  MD4: md4, MD5: md5, SHA1: sha1, SHA256: sha256, SHA384: sha384, SHA512: sha512,
};

export function fileDigestName(name: string): FileDigestName | null {
  const upper = name.toUpperCase();
  return upper in DIGESTS ? (upper as FileDigestName) : null;
}

export function fileDigestHex(name: FileDigestName, text: string): string {
  return bytesToHex(DIGESTS[name](new TextEncoder().encode(text)));
}

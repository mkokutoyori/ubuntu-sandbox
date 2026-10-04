import { sha1 } from '@/crypto/hash/sha1';
import { sha256 } from '@/crypto/hash/sha256';
import { base64ToBytes, bytesToHex } from '@/crypto/encoding';

const SSHFP_KEY_ALGORITHMS: Readonly<Record<string, number>> = {
  'ssh-rsa': 1,
  'ssh-dss': 2,
  'ecdsa-sha2-nistp256': 3,
  'ecdsa-sha2-nistp384': 3,
  'ecdsa-sha2-nistp521': 3,
  'ssh-ed25519': 4,
  'ssh-xmss@openssh.com': 5,
};

const SSHFP_DIGESTS: ReadonlyArray<readonly [number, (blob: Uint8Array) => Uint8Array]> = [
  [1, sha1],
  [2, sha256],
];

export function sshfpRecords(hostname: string, algorithm: string, publicKeyBase64: string): string[] {
  const keyAlgorithm = SSHFP_KEY_ALGORITHMS[algorithm];
  if (keyAlgorithm === undefined) return [];
  const blob = base64ToBytes(publicKeyBase64);
  return SSHFP_DIGESTS.map(([digestType, digest]) =>
    `${hostname} IN SSHFP ${keyAlgorithm} ${digestType} ${bytesToHex(digest(blob))}`);
}

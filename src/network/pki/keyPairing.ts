import { publicPartOf } from '@/crypto/rsa';
import { p256PublicPartOf } from '@/crypto/ecc';
import type { PkiPrivateKey, PkiPublicKey } from './PkiKeyPair';

export function privateKeyPairsWith(publicKey: PkiPublicKey, privateKey: PkiPrivateKey): boolean {
  if (publicKey.algorithm !== privateKey.algorithm) return false;
  const derived = privateKey.algorithm === 'rsa' ? publicPartOf(privateKey.material) : p256PublicPartOf(privateKey.material);
  return derived === publicKey.material;
}

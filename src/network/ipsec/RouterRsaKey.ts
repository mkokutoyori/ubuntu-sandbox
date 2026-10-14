import type { RsaPrivateKey, RsaPublicKey } from '@/crypto/rsa';
import { SshHostKey } from '../protocols/ssh/SshHostKey';
import { keygenPrivateKey } from '../devices/linux/network/SshKeygenMaterial';

export interface RouterRsaKey {
  readonly publicKey: RsaPublicKey;
  readonly privateKey: RsaPrivateKey;
}

const cache = new Map<string, RouterRsaKey | null>();

export function routerRsaKey(hostname: string, modulusBits: number): RouterRsaKey | null {
  const tag = `${hostname}|${modulusBits}`;
  if (cache.has(tag)) return cache.get(tag) ?? null;
  const hostKey = SshHostKey.generate(hostname, 'ssh-rsa', modulusBits);
  const parsed = keygenPrivateKey(hostKey.privateKeyBlob);
  const key = parsed !== null && parsed.algorithm === 'ssh-rsa'
    ? {
      publicKey: { n: parsed.n, e: parsed.e },
      privateKey: { n: parsed.n, e: parsed.e, d: parsed.d, p: parsed.p, q: parsed.q },
    }
    : null;
  cache.set(tag, key);
  return key;
}

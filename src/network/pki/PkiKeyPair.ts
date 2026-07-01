export interface PkiPublicKey { readonly algorithm: 'rsa' | 'ecdsa'; readonly material: string }
export interface PkiPrivateKey { readonly algorithm: 'rsa' | 'ecdsa'; readonly material: string }

let counter = 0;

function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function digest(input: string): string {
  return fnv1a(input) + fnv1a(input.split('').reverse().join('') + '|') + fnv1a(input + input);
}

function randomSeed(): string {
  counter += 1;
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${t}-${r}-${counter.toString(36)}`;
}

export class PkiKeyPair {
  private constructor(readonly publicKey: PkiPublicKey, readonly privateKey: PkiPrivateKey) {}

  static generate(algorithm: 'rsa' | 'ecdsa' = 'rsa'): PkiKeyPair {
    const seed = randomSeed();
    return new PkiKeyPair(
      { algorithm, material: `pub:${seed}` },
      { algorithm, material: `priv:${seed}` },
    );
  }

  static sign(privateKey: PkiPrivateKey, data: string): string {
    return `${privateKey.algorithm}:${digest(privateKey.material + '|' + data)}`;
  }

  static verify(publicKey: PkiPublicKey, data: string, signature: string): boolean {
    const seed = publicKey.material.split(':')[1];
    if (!seed) return false;
    const expected = `${publicKey.algorithm}:${digest('priv:' + seed + '|' + data)}`;
    return signature === expected;
  }
}

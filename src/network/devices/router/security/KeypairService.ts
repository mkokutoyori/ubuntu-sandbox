export type KeypairAlgo = 'rsa' | 'dsa' | 'ecdsa';

export interface Keypair {
  name: string;
  algo: KeypairAlgo;
  modulusBits: number;
  fingerprint: string;
  publicKeyBlob: string;
  createdAtMs: number;
}

function pseudoHex(seed: string, length: number): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  let out = '';
  while (out.length < length) {
    h = Math.imul(h, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, length);
}

export class KeypairService {
  private readonly pairs: Map<string, Keypair> = new Map();

  generate(name: string, algo: KeypairAlgo, modulusBits: number): Keypair {
    const seed = `${name}:${algo}:${modulusBits}:${this.pairs.size}`;
    const fingerprint = pseudoHex(seed, 32).match(/.{2}/g)!.join(':');
    const publicKeyBlob = pseudoHex(seed + ':blob', Math.max(64, modulusBits / 4));
    const pair: Keypair = {
      name, algo, modulusBits, fingerprint, publicKeyBlob, createdAtMs: Date.now(),
    };
    this.pairs.set(name, pair);
    return pair;
  }

  destroy(name: string): boolean { return this.pairs.delete(name); }
  get(name: string): Keypair | undefined { return this.pairs.get(name); }
  list(): readonly Keypair[] { return [...this.pairs.values()]; }
  has(algo: KeypairAlgo): boolean {
    for (const p of this.pairs.values()) if (p.algo === algo) return true;
    return false;
  }
}

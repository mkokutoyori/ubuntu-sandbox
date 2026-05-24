export type SshHostKeyAlgorithm =
  | 'ssh-ed25519'
  | 'ssh-rsa'
  | 'ecdsa-sha2-nistp256'
  | 'ecdsa-sha2-nistp384'
  | 'ecdsa-sha2-nistp521';

export interface SshHostKeyMaterialInit {
  seed: string;
  bits?: number;
  curve?: 'nistp256' | 'nistp384' | 'nistp521';
  comment?: string;
  createdAt?: number;
}

function djb2Hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

function base64Encode(bytes: number[]): string {
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += map[a >> 2];
    out += map[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? map[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? map[c & 63] : '=';
  }
  return out;
}

function hexFromSeed(seed: string, count: number): string {
  let n = djb2Hash(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    out.push((n & 0xff).toString(16).padStart(2, '0'));
  }
  return out.join('');
}

function bytesFromSeed(seed: string, count: number): number[] {
  let n = djb2Hash(seed);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    n = (n * 1664525 + 1013904223) >>> 0;
    out.push(n & 0xff);
  }
  return out;
}

function fingerprintSha256(seed: string): string {
  return 'SHA256:' + base64Encode(bytesFromSeed(`sha256:${seed}`, 32)).replace(/=+$/, '');
}

function fingerprintMd5(seed: string): string {
  const hex = hexFromSeed(`md5:${seed}`, 16);
  const pairs: string[] = [];
  for (let i = 0; i < hex.length; i += 2) pairs.push(hex.slice(i, i + 2));
  return 'MD5:' + pairs.join(':');
}

function fingerprintBabble(seed: string): string {
  const vowels = 'aeiouy';
  const consonants = 'bcdfghklmnprstvz';
  let h = djb2Hash(`babble:${seed}`);
  const parts: string[] = [];
  for (let i = 0; i < 11; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    parts.push(`${consonants[h & 15]}${vowels[(h >> 4) & 5]}${consonants[(h >> 7) & 15]}`);
  }
  return `x${parts.join('-')}x`;
}

function publicKeyBlob(algo: SshHostKeyAlgorithm, seed: string): string {
  const length = algo === 'ssh-ed25519' ? 32 : algo === 'ssh-rsa' ? 256 : 64;
  return base64Encode(bytesFromSeed(`pub:${algo}:${seed}`, length));
}

export class SshHostKeyMaterial {
  readonly algorithm: SshHostKeyAlgorithm;
  readonly publicKey: string;
  readonly privateKeyPem: string;
  readonly fingerprintSha256: string;
  readonly fingerprintMd5: string;
  readonly fingerprintBabble: string;
  readonly keySizeBits: number;
  readonly curveName: string | null;
  readonly comment: string;
  readonly seed: string;
  readonly createdAt: number;

  private constructor(init: {
    algorithm: SshHostKeyAlgorithm; publicKey: string; privateKeyPem: string;
    fingerprintSha256: string; fingerprintMd5: string; fingerprintBabble: string;
    keySizeBits: number; curveName: string | null; comment: string;
    seed: string; createdAt: number;
  }) {
    this.algorithm = init.algorithm;
    this.publicKey = init.publicKey;
    this.privateKeyPem = init.privateKeyPem;
    this.fingerprintSha256 = init.fingerprintSha256;
    this.fingerprintMd5 = init.fingerprintMd5;
    this.fingerprintBabble = init.fingerprintBabble;
    this.keySizeBits = init.keySizeBits;
    this.curveName = init.curveName;
    this.comment = init.comment;
    this.seed = init.seed;
    this.createdAt = init.createdAt;
  }

  static generate(algorithm: SshHostKeyAlgorithm, init: SshHostKeyMaterialInit): SshHostKeyMaterial {
    const seed = init.seed;
    const bits =
      algorithm === 'ssh-ed25519' ? 256
      : algorithm === 'ssh-rsa' ? (init.bits ?? 3072)
      : algorithm === 'ecdsa-sha2-nistp256' ? 256
      : algorithm === 'ecdsa-sha2-nistp384' ? 384
      : 521;
    const curve =
      algorithm === 'ecdsa-sha2-nistp256' ? 'nistp256'
      : algorithm === 'ecdsa-sha2-nistp384' ? 'nistp384'
      : algorithm === 'ecdsa-sha2-nistp521' ? 'nistp521'
      : init.curve ?? null;
    const blob = publicKeyBlob(algorithm, seed);
    const comment = init.comment ?? `host@${seed}`;
    const publicKey = `${algorithm} ${blob} ${comment}`;
    const privateKeyPem =
      `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64Encode(bytesFromSeed(`priv:${algorithm}:${seed}`, 192))}\n-----END OPENSSH PRIVATE KEY-----\n`;
    return new SshHostKeyMaterial({
      algorithm,
      publicKey,
      privateKeyPem,
      fingerprintSha256: fingerprintSha256(`${algorithm}:${seed}`),
      fingerprintMd5: fingerprintMd5(`${algorithm}:${seed}`),
      fingerprintBabble: fingerprintBabble(`${algorithm}:${seed}`),
      keySizeBits: bits,
      curveName: curve,
      comment,
      seed,
      createdAt: init.createdAt ?? Date.now(),
    });
  }

  serialized(): string {
    return [
      `# host-key ${this.algorithm} ${this.keySizeBits} bit ${this.curveName ?? ''}`.trim(),
      this.publicKey,
      this.privateKeyPem,
    ].join('\n');
  }

  knownHostsLine(host: string): string {
    return `${host} ${this.publicKey}`;
  }
}

const HOST_KEY_PREFERENCE: SshHostKeyAlgorithm[] = [
  'ssh-ed25519', 'ecdsa-sha2-nistp521', 'ecdsa-sha2-nistp384',
  'ecdsa-sha2-nistp256', 'ssh-rsa',
];

export class SshHostKeyset {
  private readonly byAlgo: Map<SshHostKeyAlgorithm, SshHostKeyMaterial>;

  constructor(keys: readonly SshHostKeyMaterial[]) {
    this.byAlgo = new Map();
    for (const k of keys) this.byAlgo.set(k.algorithm, k);
  }

  static defaults(seed: string): SshHostKeyset {
    return new SshHostKeyset([
      SshHostKeyMaterial.generate('ssh-ed25519', { seed }),
      SshHostKeyMaterial.generate('ssh-rsa', { seed, bits: 3072 }),
      SshHostKeyMaterial.generate('ecdsa-sha2-nistp256', { seed }),
    ]);
  }

  algorithms(): readonly SshHostKeyAlgorithm[] {
    return Array.from(this.byAlgo.keys());
  }

  get(algorithm: SshHostKeyAlgorithm): SshHostKeyMaterial | undefined {
    return this.byAlgo.get(algorithm);
  }

  preferred(): SshHostKeyMaterial {
    for (const algo of HOST_KEY_PREFERENCE) {
      const k = this.byAlgo.get(algo);
      if (k) return k;
    }
    const first = Array.from(this.byAlgo.values())[0];
    if (!first) throw new Error('keyset has no host keys');
    return first;
  }

  add(key: SshHostKeyMaterial): SshHostKeyset {
    const next = new Map(this.byAlgo);
    next.set(key.algorithm, key);
    return new SshHostKeyset(Array.from(next.values()));
  }

  regenerate(algorithm: SshHostKeyAlgorithm, init: SshHostKeyMaterialInit): SshHostKeyset {
    const fresh = SshHostKeyMaterial.generate(algorithm, init);
    return this.add(fresh);
  }

  fingerprintsBundle(): Record<SshHostKeyAlgorithm, string> {
    const out = {} as Record<SshHostKeyAlgorithm, string>;
    for (const [algo, k] of this.byAlgo) out[algo] = k.fingerprintSha256;
    return out;
  }

  serializedBundle(): string {
    return Array.from(this.byAlgo.values()).map(k => k.serialized()).join('\n\n');
  }

  list(): readonly SshHostKeyMaterial[] {
    return Array.from(this.byAlgo.values());
  }
}

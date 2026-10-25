import {
  AES_FAMILY, BLOWFISH_FAMILY, CAMELLIA_FAMILY, CAST5_FAMILY, DES_FAMILY, RC2_FAMILY, SEED_FAMILY, SERPENT_FAMILY, TRIPLE_DES_FAMILY,
  TWOFISH_FAMILY, type BlockCipherFamily,
} from '@/crypto/cipher/blockCiphers';
import { createModeTransform, type BlockMode, type Direction, type ModeTransform } from '@/crypto/cipher/blockModes';
import { Rc4 } from '@/crypto/cipher/rc4';

export interface GcryptAlgorithm {
  readonly name: string;
  readonly blockSize: number;
  readonly keyLength: number;
  readonly family: BlockCipherFamily | null;
}

export type GcryptMode = BlockMode | 'stream' | 'aeswrap';

const AES_WRAP_FAILURE_FILL = 0x42;

function algorithm(name: string, keyLength: number, family: BlockCipherFamily): GcryptAlgorithm {
  return { name, blockSize: family.blockSize, keyLength, family };
}

const ALGORITHMS: readonly GcryptAlgorithm[] = [
  algorithm('3DES', 24, TRIPLE_DES_FAMILY),
  algorithm('CAST5', 16, CAST5_FAMILY),
  algorithm('BLOWFISH', 16, BLOWFISH_FAMILY),
  algorithm('AES128', 16, AES_FAMILY),
  algorithm('AES192', 24, AES_FAMILY),
  algorithm('AES256', 32, AES_FAMILY),
  algorithm('TWOFISH', 32, TWOFISH_FAMILY),
  algorithm('DES', 8, DES_FAMILY),
  algorithm('TWOFISH128', 16, TWOFISH_FAMILY),
  algorithm('SERPENT128', 16, SERPENT_FAMILY),
  algorithm('SERPENT192', 24, SERPENT_FAMILY),
  algorithm('SERPENT256', 32, SERPENT_FAMILY),
  algorithm('RFC2268_40', 5, RC2_FAMILY),
  algorithm('SEED', 16, SEED_FAMILY),
  { name: 'ARCFOUR', blockSize: 1, keyLength: 16, family: null },
  algorithm('CAMELLIA128', 16, CAMELLIA_FAMILY),
  algorithm('CAMELLIA192', 24, CAMELLIA_FAMILY),
  algorithm('CAMELLIA256', 32, CAMELLIA_FAMILY),
];

const MODES: Readonly<Record<string, GcryptMode>> = {
  ECB: 'ecb', CFB: 'cfb', CBC: 'cbc', STREAM: 'stream', OFB: 'ofb', CTR: 'ctr', AESWRAP: 'aeswrap',
};

export function gcryptAlgorithmNamed(name: string): GcryptAlgorithm | undefined {
  return ALGORITHMS.find((candidate) => candidate.name === name);
}

export function gcryptModeNamed(name: string): GcryptMode | undefined {
  return MODES[name];
}

export function gcryptAlgorithmNames(): string[] {
  return ALGORITHMS.map((candidate) => candidate.name);
}

export interface GcryptTransformResult {
  readonly data: Uint8Array;
  readonly failed: boolean;
}

export interface GcryptSession {
  transform(data: Uint8Array): GcryptTransformResult;
}

export type GcryptOpenFailure = 'open' | 'setkey';

function modeIsValid(algorithm: GcryptAlgorithm, mode: GcryptMode): boolean {
  if (algorithm.family === null) return mode === 'stream';
  return mode !== 'stream';
}

class FailedSession implements GcryptSession {
  transform(data: Uint8Array): GcryptTransformResult {
    return { data: new Uint8Array(data.length).fill(AES_WRAP_FAILURE_FILL), failed: true };
  }
}

class TransformSession implements GcryptSession {
  constructor(private readonly engine: ModeTransform) {}

  transform(data: Uint8Array): GcryptTransformResult {
    try {
      return { data: this.engine.update(data), failed: false };
    } catch {
      return { data, failed: true };
    }
  }
}

export function openGcryptSession(
  algorithm: GcryptAlgorithm, mode: GcryptMode, key: Uint8Array, iv: Uint8Array, direction: Direction,
): GcryptSession | { readonly failure: GcryptOpenFailure } {
  if (!modeIsValid(algorithm, mode)) return { failure: 'open' };
  if (algorithm.family === null) {
    const stream = new Rc4(key);
    return new TransformSession({ update: (data) => stream.process(data) });
  }
  if (algorithm.family.isWeakKey?.(key)) return { failure: 'setkey' };
  if (mode === 'aeswrap') return direction === 'encrypt' ? new FailedSession() : new TransformSession({ update: () => { throw new Error('aeswrap'); } });
  const start = mode === 'ctr' ? new Uint8Array(algorithm.family.blockSize) : iv;
  return new TransformSession(createModeTransform(mode as BlockMode, algorithm.family.create(key), direction, start));
}

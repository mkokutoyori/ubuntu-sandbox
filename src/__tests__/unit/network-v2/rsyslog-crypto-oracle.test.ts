/*
 * Oracle - the cipher engines under lmcry_gcry and lmcry_ossl against the real libgcrypt 1.10.3 and OpenSSL 3.0.13
 * (scripts/oracle/record_rsyslog_crypto.py).  Every algorithm is paired with every mode in the order rsyslog calls libgcrypt
 * (open, setkey, setiv, then in-place encryption of successive buffers whose chaining state must survive), so the pairings
 * libgcrypt refuses at open, the weak DES keys it refuses at setkey, the stream modes on ragged buffers and the failure of AESWRAP
 * (the in-place call is rejected and the buffer is left filled with 0x42) are all pinned.  OpenSSL is recorded through
 * `openssl enc -nopad` on the concatenation of the buffers.  The DES weak-key table is swept with parity-bit variants because
 * libgcrypt compares keys without their parity bits.
 * In CTR mode libgcrypt takes its counter from gcry_cipher_setctr, so the gcry_cipher_setiv rsyslog calls leaves the counter at zero
 * and the IV written to the .encinfo file does not influence the keystream; the recorded vectors pin that.
 * Measured before the port (git stash push -- src/network src/crypto): the whole file falls, the modules it imports do not exist;
 * there is no witness other than the recorded vectors themselves, which come from the real libraries and not from this code.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ENC_SUITES } from '@/network/crypto/openssl/OpenSslEnc';
import { createModeTransform } from '@/crypto/cipher/blockModes';
import { TRIPLE_DES_FAMILY, DES_FAMILY } from '@/crypto/cipher/blockCiphers';
import {
  gcryptAlgorithmNamed, gcryptModeNamed, openGcryptSession, type GcryptSession,
} from '@/network/rsyslog/crypto/GcryptSuite';

interface GcryptChunk { in: string; out: string; error: number; decrypted?: string; decryptError?: number }
interface GcryptCase {
  label: string; algo: string; mode: string; key: string; iv: string; open: number; setkey: number; chunks: GcryptChunk[];
}
interface Weak { key: string; setkey: number }
const gcrypt = JSON.parse(readFileSync('src/__tests__/support/oracle/rsyslog-crypto/gcrypt-1.10.3.json', 'utf8')) as {
  cases: GcryptCase[]; desWeakKeys: Weak[]; tripleDesWeakKeys: Weak[];
};
const openssl = JSON.parse(readFileSync('src/__tests__/support/oracle/rsyslog-crypto/openssl-3.0.13.json', 'utf8')) as {
  cases: { name: string; key: string; iv: string; chunks: { in: string; out: string }[] }[];
};

const bytes = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const hex = (data: Uint8Array): string => Buffer.from(data).toString('hex');

function session(testCase: GcryptCase, direction: 'encrypt' | 'decrypt'): GcryptSession | { failure: string } {
  const algorithm = gcryptAlgorithmNamed(testCase.algo);
  const mode = gcryptModeNamed(testCase.mode);
  if (algorithm === undefined || mode === undefined) return { failure: 'unknown' };
  return openGcryptSession(algorithm, mode, bytes(testCase.key), bytes(testCase.iv), direction);
}

describe('libgcrypt: every algorithm with every mode', () => {
  const known = gcrypt.cases.filter((testCase) => gcryptAlgorithmNamed(testCase.algo) !== undefined);

  it('witness: the recorded corpus is not empty and covers refusals, weak keys and successes', () => {
    expect(known.length).toBeGreaterThan(60);
    expect(known.some((testCase) => testCase.open !== 0)).toBe(true);
    expect(known.some((testCase) => testCase.setkey !== 0)).toBe(true);
    expect(known.some((testCase) => testCase.chunks.length > 0 && testCase.chunks.every((chunk) => chunk.error === 0))).toBe(true);
  });

  for (const testCase of known) {
    it(`${testCase.algo}/${testCase.mode} ${testCase.label}`, () => {
      const opened = session(testCase, 'encrypt');
      if (testCase.open !== 0) {
        expect(opened).toEqual({ failure: 'open' });
        return;
      }
      if (testCase.setkey !== 0) {
        expect(opened).toEqual({ failure: 'setkey' });
        return;
      }
      expect('failure' in opened).toBe(false);
      const encrypting = opened as GcryptSession;
      const ciphertexts: Uint8Array[] = [];
      for (const chunk of testCase.chunks) {
        const result = encrypting.transform(bytes(chunk.in));
        expect(result.failed).toBe(chunk.error !== 0);
        expect(hex(result.data)).toBe(chunk.out);
        ciphertexts.push(result.data);
      }
      if (testCase.chunks.some((chunk) => chunk.error !== 0)) return;
      const decrypting = session(testCase, 'decrypt') as GcryptSession;
      testCase.chunks.forEach((chunk, index) => {
        expect(hex(decrypting.transform(ciphertexts[index]).data)).toBe(chunk.decrypted);
      });
    });
  }
});

describe('libgcrypt: weak keys', () => {
  it('DES refuses exactly the keys libgcrypt refuses, parity bits ignored', () => {
    const weak = gcrypt.desWeakKeys;
    expect(weak.some((entry) => entry.setkey !== 0)).toBe(true);
    expect(weak.some((entry) => entry.setkey === 0)).toBe(true);
    for (const entry of weak) expect(DES_FAMILY.isWeakKey?.(bytes(entry.key))).toBe(entry.setkey !== 0);
  });

  it('3DES refuses a key when any of its three DES keys is weak', () => {
    expect(gcrypt.tripleDesWeakKeys.every((entry) => entry.setkey !== 0)).toBe(true);
    for (const entry of gcrypt.tripleDesWeakKeys) expect(TRIPLE_DES_FAMILY.isWeakKey?.(bytes(entry.key))).toBe(true);
  });
});

describe('OpenSSL: the enc suites in streaming mode', () => {
  it('witness: the recorded ciphers include block, stream-like and 8-byte block suites', () => {
    const names = new Set(openssl.cases.map((entry) => entry.name));
    expect(names.has('aes-128-cbc')).toBe(true);
    expect(names.has('aes-256-ctr')).toBe(true);
    expect(names.has('des-ede3-cbc')).toBe(true);
  });

  openssl.cases.forEach((testCase, index) => {
    it(`${testCase.name} #${index}`, () => {
      const suite = ENC_SUITES[testCase.name];
      expect(suite).toBeDefined();
      const key = bytes(testCase.key);
      const transform = createModeTransform(suite.mode, suite.family.create(key), 'encrypt', bytes(testCase.iv));
      for (const chunk of testCase.chunks) expect(hex(transform.update(bytes(chunk.in)))).toBe(chunk.out);
    });
  });
});

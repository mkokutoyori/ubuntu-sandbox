/*
 * Probe - the Zstandard codec (src/network/compression/zstd: RFC 8878 frames, FSE and Huffman entropy coders, XXH64) that stores the compressed data objects of the
 * systemd journal.  libzstd itself is the oracle, through node:zlib, in both directions: the decoder reads what libzstd writes at levels 1, 3, 9 and 19 (raw, RLE and
 * compressed blocks, Huffman literals with FSE-coded weights, custom and repeated sequence tables, repeat offsets, several blocks, a content checksum), and libzstd reads
 * what the encoder writes (single-segment frames, Huffman literals, predefined or custom FSE tables chosen by estimated cost).  Damaged frames must be refused
 * without an exception.  The default tables are checked against the totals of the specification.
 * Measured before the codec existed (git stash push -- src/network): the modules are untracked-new, so every case fails at import.
 */
import { describe, expect, it } from 'vitest';
import { zstdCompressSync } from 'node:zlib';
import { zstdDecompress } from '@/network/compression/zstd/ZstdDecoder';
import { LL_BASELINE, LL_DEFAULT, ML_BASELINE, ML_DEFAULT, ML_EXTRA_BITS, OF_DEFAULT } from '@/network/compression/zstd/ZstdTables';

const total = (counts: number[]): number => counts.reduce((sum, value) => sum + (value === -1 ? 1 : value), 0);

function corpus(): Uint8Array[] {
  const cases: Uint8Array[] = [new Uint8Array(0), Uint8Array.of(1), new Uint8Array(1000).fill(7), new TextEncoder().encode('hello hello hello hello world '.repeat(40))];
  let seed = 12345;
  const next = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 16; };
  cases.push(Uint8Array.from({ length: 3000 }, () => next() & 255));
  cases.push(Uint8Array.from({ length: 20000 }, () => 97 + (next() % 6)));
  cases.push(new TextEncoder().encode(Array.from({ length: 4000 }, (_, i) => `line ${i} of the journal with some words ${next() % 50}`).join('\n')));
  cases.push(Uint8Array.from({ length: 300000 }, (_, i) => (i % 251 === 0 ? next() & 255 : 65 + (i % 13))));
  return cases;
}

describe('zstd tables', () => {
  it('has the normalized counts of the specification', () => {
    expect(total(LL_DEFAULT)).toBe(64);
    expect(total(ML_DEFAULT)).toBe(64);
    expect(total(OF_DEFAULT)).toBe(32);
    expect(LL_DEFAULT.length).toBe(36);
    expect(ML_DEFAULT.length).toBe(53);
    expect(OF_DEFAULT.length).toBe(29);
    expect(LL_BASELINE.length).toBe(36);
    expect(ML_BASELINE.length).toBe(53);
    expect(ML_EXTRA_BITS.length).toBe(53);
  });
});

describe('zstd decoder against libzstd (node)', () => {
  for (const [index, input] of corpus().entries()) {
    for (const level of [1, 3, 9, 19]) {
      it(`decodes what libzstd level ${level} makes of corpus ${index}`, () => {
        const compressed = zstdCompressSync(input, { params: { 100: level } as never });
        const result = zstdDecompress(Uint8Array.from(compressed));
        expect(result.ok).toBe(true);
        if (result.ok) expect(Buffer.from(result.bytes).equals(Buffer.from(input))).toBe(true);
      });
    }
  }
});

import { zstdCompress } from '@/network/compression/zstd/ZstdEncoder';
import { zstdDecompressSync } from 'node:zlib';

describe('zstd encoder against libzstd (node)', () => {
  for (const [index, input] of corpus().entries()) {
    it(`makes a frame libzstd decodes to corpus ${index}`, () => {
      const compressed = zstdCompress(input);
      expect(Buffer.from(zstdDecompressSync(Buffer.from(compressed))).equals(Buffer.from(input))).toBe(true);
    });
    it(`makes a frame the decoder reads back as corpus ${index}`, () => {
      const result = zstdDecompress(zstdCompress(input));
      expect(result.ok).toBe(true);
      if (result.ok) expect(Buffer.from(result.bytes).equals(Buffer.from(input))).toBe(true);
    });
  }
});

describe('zstd decoder on damaged frames', () => {
  it('refuses or accepts every mutated frame without throwing, and never reads beyond the output limit', () => {
    let seed = 99;
    const next = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed >>> 8; };
    const original = zstdCompress(new TextEncoder().encode(Array.from({ length: 300 }, (_, i) => `entry ${i} ${i % 7}`).join('\n')));
    let refused = 0;
    for (let round = 0; round < 400; round++) {
      const mutated = Uint8Array.from(original);
      for (let k = 0; k < 1 + (next() % 3); k++) mutated[next() % mutated.length] = next() & 255;
      const result = zstdDecompress(mutated, 1 << 20);
      if (!result.ok) refused++;
    }
    expect(refused).toBeGreaterThan(50);
  });

  it('refuses truncations, an empty input and a bad magic number', () => {
    const frame = zstdCompress(new TextEncoder().encode('journal payload '.repeat(60)));
    for (let cut = 0; cut < frame.length; cut++) expect(zstdDecompress(frame.subarray(0, cut)).ok).toBe(false);
    expect(zstdDecompress(Uint8Array.of(1, 2, 3, 4, 5)).ok).toBe(false);
  });

  it('skips a skippable frame and reads the frame that follows', () => {
    const frame = zstdCompress(new TextEncoder().encode('after the skippable frame'));
    const joined = Uint8Array.from([0x50, 0x2a, 0x4d, 0x18, 3, 0, 0, 0, 9, 9, 9, ...frame]);
    const result = zstdDecompress(joined);
    expect(result.ok && Buffer.from(result.bytes).toString()).toBe('after the skippable frame');
  });

  it('checks the content checksum when the frame carries one', () => {
    const frame = Uint8Array.from(zstdCompressSync(Buffer.from('checksummed payload '.repeat(30)), { params: { 201: 1 } as never }));
    expect(zstdDecompress(frame).ok).toBe(true);
    const damaged = Uint8Array.from(frame);
    damaged[damaged.length - 1] ^= 0xff;
    expect(zstdDecompress(damaged).ok).toBe(false);
  });
});

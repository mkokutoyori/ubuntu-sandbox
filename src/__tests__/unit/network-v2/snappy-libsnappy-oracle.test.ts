/*
 * Probe - the Snappy codec used by impstats' Prometheus remote write (prometheus_remote_write.c calls snappy_compress from libsnappy).  The fixture
 * (support/oracle/snappy/libsnappy-vectors.json) was recorded by scripts/oracle/record_snappy.py from the installed libsnappy 1.1.10: 564 inputs
 * (empty, 1-79 bytes, block boundaries 65535/65536/65537, repeats, random, word soup, a Prometheus-like series) with the exact bytes snappy_compress
 * produced, and 1912 corrupted or forged streams with the verdict of snappy_validate_compressed_buffer and snappy_uncompressed_length.  The compressor must
 * reproduce every stream byte for byte, the decompressor must agree on every verdict and every decoded payload.
 * Measured before the codec existed (git stash push -- src/network): the module is untracked-new, so all 5 cases fail at import.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { snappyCompress, snappyMaxCompressedLength, snappyUncompress, snappyUncompressedLength } from '@/network/rsyslog/Snappy';

interface Vectors {
  readonly compress: { name: string; input: string | { repeat: string; size: number }; compressed: string }[];
  readonly probes: { stream: string; valid: boolean; length: number | null; decoded: string | null }[];
}

const vectors: Vectors = JSON.parse(readFileSync(new URL('../../support/oracle/snappy/libsnappy-vectors.json', import.meta.url), 'utf8'));
const bytesOf = (hex: string): Uint8Array => Uint8Array.from(Buffer.from(hex, 'hex'));
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

function inputOf(spec: string | { repeat: string; size: number }): Uint8Array {
  if (typeof spec === 'string') return bytesOf(spec);
  const unit = bytesOf(spec.repeat);
  const out = new Uint8Array(spec.size);
  for (let index = 0; index < spec.size; index++) out[index] = unit[index % unit.length];
  return out;
}

describe('snappy against libsnappy', () => {
  it('compresses every input to the bytes libsnappy produces', () => {
    const different = vectors.compress.filter((entry) => hexOf(snappyCompress(inputOf(entry.input))) !== entry.compressed).map((entry) => entry.name);
    expect(different).toEqual([]);
  });

  it('decompresses what libsnappy compressed, to the original input', () => {
    for (const entry of vectors.compress) {
      const result = snappyUncompress(bytesOf(entry.compressed));
      expect(result.ok, entry.name).toBe(true);
      if (result.ok) expect(hexOf(result.bytes) === hexOf(inputOf(entry.input)), entry.name).toBe(true);
    }
  });

  it('agrees with libsnappy on every corrupted or forged stream', () => {
    const disagreements: string[] = [];
    for (const probe of vectors.probes) {
      const stream = bytesOf(probe.stream);
      const result = snappyUncompress(stream);
      const length = snappyUncompressedLength(stream);
      if (result.ok !== probe.valid || length !== probe.length || (result.ok && hexOf(result.bytes) !== probe.decoded)) disagreements.push(probe.stream.slice(0, 40));
    }
    expect(disagreements).toEqual([]);
  });

  it('witness: the probes hold both streams libsnappy accepts and streams it refuses', () => {
    expect(vectors.probes.filter((probe) => probe.valid).length).toBeGreaterThan(500);
    expect(vectors.probes.filter((probe) => !probe.valid).length).toBeGreaterThan(1000);
  });

  it('bounds the output by snappy_max_compressed_length', () => {
    expect(snappyMaxCompressedLength(0)).toBe(32);
    expect(snappyMaxCompressedLength(6)).toBe(39);
    expect(snappyMaxCompressedLength(65536)).toBe(32 + 65536 + 10922);
  });
});

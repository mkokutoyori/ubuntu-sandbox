/**
 * Probe — src/network/rsyslog/Zlib.ts (the 'z' message extension and compression.mode="single").
 *
 * Measured against Node's own zlib, which is the oracle here: every stream the
 * simulator produces must inflate with the real library, every stream the real
 * library produces at every level must inflate with the simulator, and the
 * two-byte header and the trailing Adler-32 must be bit-identical for the level
 * mapping rsyslog relies on. Before the change the module does not exist: every
 * case fails to import. No case passes either way.
 */
import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { adler32, zlibCompress, zlibDecompress, ZlibError } from '@/network/rsyslog/Zlib';

const encoder = new TextEncoder();

const SAMPLES: Record<string, string> = {
  empty: '',
  short: 'hello',
  repetitive: 'a'.repeat(1000),
  syslogLine: '<13>Oct 19 12:00:01 ubuntu alice: hello hello hello hello world '.repeat(50),
  pseudoRandom: Array.from({ length: 3000 }, (_, index) => String.fromCharCode(33 + ((index * 7919) % 90))).join(''),
  multiBlockStored: 'x'.repeat(70000),
};

describe('Zlib codec against node:zlib', () => {
  for (const [name, text] of Object.entries(SAMPLES)) {
    for (const level of [0, 1, 5, 6, 9]) {
      it(`${name} level ${level}: simulator output inflates with the real library`, () => {
        const data = encoder.encode(text);
        expect(Buffer.from(inflateSync(Buffer.from(zlibCompress(data, level))))).toEqual(Buffer.from(data));
      });
      it(`${name} level ${level}: real library output inflates with the simulator`, () => {
        const data = encoder.encode(text);
        expect(Buffer.from(zlibDecompress(new Uint8Array(deflateSync(Buffer.from(data), { level }))))).toEqual(Buffer.from(data));
      });
    }
  }

  it('matches the real two-byte header for each level class', () => {
    const data = encoder.encode('hello');
    for (const level of [1, 2, 5, 6, 7, 9]) {
      expect(Buffer.from(zlibCompress(data, level).subarray(0, 2))).toEqual(deflateSync(Buffer.from(data), { level }).subarray(0, 2));
    }
  });

  it('is byte-identical to zlib for a short literal-only input at level 9', () => {
    expect(Buffer.from(zlibCompress(encoder.encode('hello'), 9)).toString('hex')).toBe(deflateSync(Buffer.from('hello'), { level: 9 }).toString('hex'));
  });

  it('adler32 follows RFC 1950', () => {
    expect(adler32(encoder.encode('Wikipedia'))).toBe(0x11e60398);
  });

  it('rejects a corrupted checksum, a truncated stream and an output past the limit', () => {
    const good = zlibCompress(encoder.encode('hello world hello world'), 6);
    const corrupted = good.slice();
    corrupted[corrupted.length - 1] ^= 0xff;
    expect(() => zlibDecompress(corrupted)).toThrow(ZlibError);
    expect(() => zlibDecompress(good.subarray(0, good.length - 6))).toThrow(ZlibError);
    expect(() => zlibDecompress(zlibCompress(encoder.encode('a'.repeat(500)), 6), 100)).toThrow(/exceeds limit/);
  });
});

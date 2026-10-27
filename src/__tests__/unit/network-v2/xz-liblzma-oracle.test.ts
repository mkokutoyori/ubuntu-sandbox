/*
 * Probe - the xz decoder (xz container, LZMA2 chunks, LZMA range decoder, CRC32 / CRC64 / SHA-256 checks) against liblzma.
 * scripts/oracle/record_xz.py compressed ten inputs (empty, one byte, zeros, text, random, mixed, a byte ramp) with every check type and five presets, then damaged
 * the small streams (25 single-bit flips each for sixty of them, truncations, trailing bytes) and kept liblzma's verdict: the decoded bytes, or a failure.  Every
 * valid stream must decode to the same bytes and every damaged stream must be refused or decoded identically, whichever liblzma did.
 * Measured with the tracked sources stashed (git stash push -- src/network): the journal-level case falls (JournalView sent XZ objects to ENOMEM unconditionally); the 3 decoder
 * cases pass either way (STRUCTURAL: the decoder is an untracked-new module that stays in place), and their corpus is its own witness (237 streams decode, 1691 fail,
 * so a decoder that refused everything or accepted everything fails).
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { crc64, xzDecompress } from '@/network/compression/xz/XzDecoder';
import { JournalView } from '@/network/devices/linux/journal/format/JournalView';

interface Vector {
  readonly label: string;
  readonly stream: string;
  readonly ok: boolean;
  readonly bytes?: string;
}

const vectors = (JSON.parse(gunzipSync(readFileSync(new URL('../../support/oracle/xz/liblzma-vectors.json.gz', import.meta.url))).toString('utf8')) as { vectors: Vector[] }).vectors;

describe('xz decoder against liblzma', () => {
  it('replays a corpus with valid and damaged streams', () => {
    expect(vectors.filter((vector) => vector.ok).length).toBeGreaterThan(200);
    expect(vectors.filter((vector) => !vector.ok).length).toBeGreaterThan(1500);
  });

  it('gives liblzma\'s verdict and bytes on every stream', () => {
    const disagreements: string[] = [];
    for (const vector of vectors) {
      const result = xzDecompress(Buffer.from(vector.stream, 'base64'));
      if (result.ok !== vector.ok) disagreements.push(`${vector.label}: liblzma ${vector.ok ? 'accepts' : 'refuses'}, decoder ${result.ok ? 'accepts' : `refuses (${result.reason})`}`);
      else if (result.ok && Buffer.from(result.bytes).toString('base64') !== vector.bytes) disagreements.push(`${vector.label}: different bytes`);
    }
    expect(disagreements.slice(0, 15)).toEqual([]);
  }, 120_000);

  it('CRC-64/XZ of the check string is the catalogued value', () => {
    expect(crc64(Buffer.from('123456789'))).toBe(0x995dc9bbdf1939fan);
  });

  it('a journal object flagged XZ is decoded, and one that is not XZ fails with ENOMEM as liblzma does inside journald', () => {
    const view = new JournalView(new Uint8Array(272));
    const valid = vectors.find((vector) => vector.ok && vector.label.startsWith('text-300/check4/preset6')) as Vector;
    const decoded = view.decompress(1, Buffer.from(valid.stream, 'base64'));
    expect(decoded.ok).toBe(true);
    expect(Buffer.from(decoded.bytes as Uint8Array).toString('base64')).toBe(valid.bytes);
    expect(view.decompress(1, Buffer.from('not an xz stream at all')).errno).toBe('ENOMEM');
    expect(view.decompress(2, Buffer.from('not an lz4 blob at all')).errno).toBe('EFBIG');
    const literal = Buffer.concat([Buffer.from([5, 0, 0, 0, 0, 0, 0, 0, 0x50]), Buffer.from('hello')]);
    expect(Buffer.from(view.decompress(2, literal).bytes as Uint8Array).toString()).toBe('hello');
  });
});

/**
 * Probe - the incremental inflater behind imptcp's compression.mode="stream:always" (plugins/imptcp/imptcp.c DataRcvdCompressed calls
 * inflate(Z_SYNC_FLUSH) on every recv() and logs "zlib state <name> (<code>)").  ZlibInflateStream is compared with the real zlib that
 * node links (inflateSync, and the streaming inflate for the partial-input behaviour): the bytes produced for a stream cut at random
 * places must be the bytes the whole stream gives, for every compression level (stored, fixed and dynamic blocks) and for streams with
 * several sync-flushed segments; a stream corrupted by one flipped bit must be refused exactly when zlib refuses it, with the same
 * return code (Z_DATA_ERROR, Z_NEED_DICT); a stream that stops early is not reported as ended; bytes after the trailer are counted.
 * Measured against the base commit (git stash push -- src/network): every case fails - ZlibInflateStream and the resumable Inflater
 * did not exist (the one-shot zlibDecompress was the only inflater).  The WITNESS is the one-shot decoder, which the new Inflater
 * now also serves: zlibDecompress of the same fixtures is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { deflateSync, inflateSync, constants } from 'node:zlib';
import { zlibDecompress, zlibErrorCode, ZlibError, ZlibInflateStream, Z_DATA_ERROR, Z_NEED_DICT } from '@/network/rsyslog/Zlib';

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function sample(random: () => number, kind: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    if (kind === 0) out[index] = Math.floor(random() * 256);
    else if (kind === 1) out[index] = 97 + (index % 7);
    else out[index] = random() < 0.7 ? 97 + Math.floor(random() * 6) : Math.floor(random() * 256);
  }
  return out;
}

function chunked(bytes: Uint8Array, random: () => number): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let at = 0;
  while (at < bytes.length) {
    const size = 1 + Math.floor(random() * Math.min(40, bytes.length - at));
    parts.push(bytes.subarray(at, at + size));
    at += size;
  }
  return parts;
}

function feed(stream: ZlibInflateStream, parts: Uint8Array[]): { output: Buffer; ended: boolean; trailing: number } {
  const produced: Buffer[] = [];
  let trailing = 0;
  for (const part of parts) {
    const result = stream.write(part);
    produced.push(Buffer.from(result.output));
    trailing += result.trailingBytes;
  }
  return { output: Buffer.concat(produced), ended: stream.ended, trailing };
}

describe('resumable zlib inflater against zlib', () => {
  it('witness: the one-shot decoder still agrees with zlib', () => {
    const data = sample(lcg(1), 2, 3000);
    expect(Buffer.from(zlibDecompress(new Uint8Array(deflateSync(data))))).toEqual(data);
  });

  it('rebuilds the stream whatever the chunking, at every level and for every content kind', () => {
    const random = lcg(20260401);
    let compared = 0;
    for (let level = 0; level <= 9; level++) {
      for (let kind = 0; kind < 3; kind++) {
        for (const length of [0, 1, 17, 300, 5000, 70000]) {
          const data = sample(random, kind, length);
          const compressed = deflateSync(data, { level });
          const result = feed(new ZlibInflateStream(), chunked(compressed, random));
          expect(result.ended).toBe(true);
          expect(result.output.equals(data)).toBe(true);
          compared++;
        }
      }
    }
    expect(compared).toBe(180);
  });

  it('follows sync-flushed segments, as a peer that flushes after every message sends them', () => {
    const random = lcg(7);
    const segments = [sample(random, 2, 90), sample(random, 1, 400), sample(random, 0, 20)];
    let stream = Buffer.alloc(0);
    const encoder = require('node:zlib').createDeflate({ flush: constants.Z_SYNC_FLUSH }) as import('node:zlib').Deflate;
    const collected: Buffer[] = [];
    encoder.on('data', (piece: Buffer) => collected.push(piece));
    for (const segment of segments) {
      encoder.write(segment);
      encoder.flush();
    }
    encoder.end();
    return new Promise<void>((resolve) => {
      encoder.on('end', () => {
        stream = Buffer.concat(collected);
        const result = feed(new ZlibInflateStream(), chunked(stream, random));
        expect(result.ended).toBe(true);
        expect(result.output.equals(Buffer.concat(segments))).toBe(true);
        resolve();
      });
    });
  });

  it('agrees with zlib about which one-bit corruptions are refused, and with the return code', () => {
    const random = lcg(99);
    let refused = 0;
    let accepted = 0;
    for (let round = 0; round < 400; round++) {
      const data = sample(random, round % 3, 50 + Math.floor(random() * 600));
      const compressed = Buffer.from(deflateSync(data, { level: round % 10 }));
      const corrupted = Buffer.from(compressed);
      corrupted[Math.floor(random() * corrupted.length)] ^= 1 << Math.floor(random() * 8);
      let expected: { code: string } | null = null;
      try {
        inflateSync(corrupted);
      } catch (error) {
        expected = { code: (error as { code: string }).code };
      }
      let thrown: ZlibError | null = null;
      let ended = false;
      try {
        ended = feed(new ZlibInflateStream(), chunked(corrupted, random)).ended;
      } catch (error) {
        if (!(error instanceof ZlibError)) throw error;
        thrown = error;
      }
      if (expected === null) {
        expect(thrown).toBeNull();
        expect(ended).toBe(true);
        accepted++;
      } else if (expected.code === 'Z_BUF_ERROR') {
        expect(thrown === null && !ended).toBe(true);
        refused++;
      } else {
        expect(thrown).not.toBeNull();
        expect(zlibErrorCode(thrown as ZlibError)).toBe(expected.code === 'Z_NEED_DICT' ? Z_NEED_DICT : Z_DATA_ERROR);
        refused++;
      }
    }
    expect(refused).toBeGreaterThan(200);
    expect(accepted).toBeGreaterThan(0);
  });

  it('does not report a stream cut short as ended', () => {
    const random = lcg(5);
    const compressed = deflateSync(sample(random, 2, 2000));
    for (const cut of [1, 2, 5, 40, compressed.length - 5, compressed.length - 1]) {
      const result = feed(new ZlibInflateStream(), chunked(compressed.subarray(0, cut), random));
      expect(result.ended).toBe(false);
    }
  });

  it('counts the bytes that follow the trailer', () => {
    const random = lcg(6);
    const compressed = deflateSync(sample(random, 1, 500));
    const padded = Buffer.concat([compressed, Buffer.from('tail')]);
    const result = feed(new ZlibInflateStream(), [padded]);
    expect(result.ended).toBe(true);
    expect(result.trailing).toBe(4);
  });

  it('refuses a stream that asks for a preset dictionary with Z_NEED_DICT', () => {
    const withDictionary = deflateSync(Buffer.from('hello world hello world'), { dictionary: Buffer.from('hello world') });
    let thrown: ZlibError | null = null;
    try {
      feed(new ZlibInflateStream(), [new Uint8Array(withDictionary)]);
    } catch (error) {
      thrown = error as ZlibError;
    }
    expect(thrown).not.toBeNull();
    expect(zlibErrorCode(thrown as ZlibError)).toBe(Z_NEED_DICT);
  });
});

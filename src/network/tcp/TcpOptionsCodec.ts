/**
 * TcpOptionsCodec — pure encode/decode between a semantic option set and
 * `TcpSegment.options`/`dataOffset` (PRD-TCP.md P6).
 *
 * Segments in this simulator are plain structured objects passed between
 * hosts, never real byte buffers (`computeTcpChecksum` already treats
 * `payload`, not the header, as the only checksummed bytes) — so, like
 * `RndcWireCodec`/`SftpWireCodec` before it, this codec's job is a real
 * *semantic* encode/decode (option kind ⇄ named fields), not literal
 * byte-packing. `optionsDataOffset` still reports a realistic 32-bit-word
 * count so a `dataOffset` value on the wire remains meaningful for any
 * tooling that inspects it (e.g. a future `tcpdump`-style formatter).
 */
import type { TcpOption } from './types';

export interface TcpOptionsSet {
  mss?: number;
  windowScale?: number;
  sackPermitted?: boolean;
  sackBlocks?: ReadonlyArray<{ start: number; end: number }>;
  timestamp?: { tsVal: number; tsEcr: number };
}

export function encodeOptions(opts: TcpOptionsSet): TcpOption[] {
  const options: TcpOption[] = [];
  if (opts.mss !== undefined) options.push({ kind: 'mss', value: opts.mss });
  if (opts.windowScale !== undefined) options.push({ kind: 'window-scale', shift: opts.windowScale });
  if (opts.sackPermitted) options.push({ kind: 'sack-permitted' });
  if (opts.sackBlocks && opts.sackBlocks.length > 0) options.push({ kind: 'sack', blocks: opts.sackBlocks });
  if (opts.timestamp) options.push({ kind: 'timestamp', tsVal: opts.timestamp.tsVal, tsEcr: opts.timestamp.tsEcr });
  return options;
}

export function decodeOptions(options: readonly TcpOption[]): TcpOptionsSet {
  const out: TcpOptionsSet = {};
  for (const opt of options) {
    switch (opt.kind) {
      case 'mss': out.mss = opt.value; break;
      case 'window-scale': out.windowScale = opt.shift; break;
      case 'sack-permitted': out.sackPermitted = true; break;
      case 'sack': out.sackBlocks = opt.blocks; break;
      case 'timestamp': out.timestamp = { tsVal: opt.tsVal, tsEcr: opt.tsEcr }; break;
      default: break;
    }
  }
  return out;
}

/** Real per-option byte cost (kind+length+data, padded to 4 bytes with NOPs), rounded up to whole 32-bit words and added to the fixed 5-word (20-byte) header. */
export function optionsDataOffset(options: readonly TcpOption[]): number {
  let bytes = 0;
  for (const opt of options) {
    switch (opt.kind) {
      case 'mss': bytes += 4; break;
      case 'window-scale': bytes += 3; break;
      case 'sack-permitted': bytes += 2; break;
      case 'sack': bytes += 2 + opt.blocks.length * 8; break;
      case 'timestamp': bytes += 10; break;
      case 'nop': bytes += 1; break;
      case 'end': bytes += 1; break;
      default: break;
    }
  }
  const paddedWords = Math.ceil(bytes / 4);
  return 5 + paddedWords;
}

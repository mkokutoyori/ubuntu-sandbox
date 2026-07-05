/**
 * TFTP (RFC 2347 "Option Extension", RFC 2348 `blksize`, RFC 2349
 * `timeout`/`tsize`) — negotiation: a server that understands none of
 * the requested options simply doesn't send an `OACK` at all (falls
 * back to the RFC 1350 defaults, RFC 2347 §2); one that understands a
 * subset echoes back only the options it's honoring, each clamped to a
 * sane range.
 */
import type { TftpOptions } from './types';

const BLKSIZE_MIN = 8;
const BLKSIZE_MAX = 65464; // RFC 2348 §3 — largest blksize that fits a UDP datagram with the 4-byte DATA header
const TIMEOUT_MIN = 1;
const TIMEOUT_MAX = 255;

/** Server side: clamps whatever was requested to protocol-legal bounds; `tsize` in a request is a placeholder (0) the caller replaces with the real file size for RRQ, or accepts as-is for WRQ. */
export function negotiateOptions(requested: TftpOptions | undefined): TftpOptions | null {
  if (!requested) return null;
  const negotiated: { blksize?: number; timeout?: number; tsize?: number } = {};
  if (requested.blksize !== undefined) {
    negotiated.blksize = Math.min(Math.max(requested.blksize, BLKSIZE_MIN), BLKSIZE_MAX);
  }
  if (requested.timeout !== undefined) {
    negotiated.timeout = Math.min(Math.max(requested.timeout, TIMEOUT_MIN), TIMEOUT_MAX);
  }
  if (requested.tsize !== undefined) {
    negotiated.tsize = requested.tsize;
  }
  return Object.keys(negotiated).length > 0 ? negotiated : null;
}

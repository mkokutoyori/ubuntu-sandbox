/**
 * `rndc` wire codec (PRD-Nslookup-Dig-Rndc-Runas.md §4.1) — pure encode/
 * decode + HMAC signing, no I/O (mirrors the SftpWireCodec/SftpWireSession
 * split: this module is the codec, `RndcClient.ts`/`RndcServer.ts` own the
 * actual TCP transport).
 *
 * The real ISC `rndc` protocol packs its command dictionary into a binary
 * format ("isccc") signed with an HMAC digest. This simulator models the two
 * properties that actually matter — HMAC authenticity and explicit command
 * content — without reproducing the ISC binary format bit-for-bit: the
 * signed payload is JSON, framed the same length-prefixed way the SFTP wire
 * codec frames its packets (`uint32 length` + body).
 */

import type { HashAlgorithm } from '@/crypto';
import { MD5, SHA256, hmac, utf8ToBytes, bytesToUtf8, bytesToHex, base64ToBytes } from '@/crypto';

export interface RndcRequest {
  readonly nonce: number;
  readonly command: string;
}

export interface RndcResponse {
  readonly nonce: number;
  readonly result: number;
  readonly text: string;
}

export type RndcHmacAlgorithm = 'hmac-md5' | 'hmac-sha256';

export interface RndcWireEnvelope {
  readonly hmac: string;
  readonly payload: RndcRequest | RndcResponse;
}

const HASHES: Readonly<Record<RndcHmacAlgorithm, HashAlgorithm>> = {
  'hmac-md5': MD5,
  'hmac-sha256': SHA256,
};

export function isSupportedRndcAlgorithm(algorithm: string): algorithm is RndcHmacAlgorithm {
  return algorithm === 'hmac-md5' || algorithm === 'hmac-sha256';
}

function hashFor(algorithm: string): HashAlgorithm {
  if (!isSupportedRndcAlgorithm(algorithm)) {
    throw new Error(`rndc: unsupported key algorithm '${algorithm}'`);
  }
  return HASHES[algorithm];
}

/** HMAC(algorithm, secret, JSON.stringify(payload)) as lowercase hex, keyed by the named.conf key's base64 secret. */
export function signRndcPayload(
  payload: RndcRequest | RndcResponse,
  algorithm: string,
  secretBase64: string,
): string {
  const key = base64ToBytes(secretBase64);
  const message = utf8ToBytes(JSON.stringify(payload));
  return bytesToHex(hmac(hashFor(algorithm), key, message));
}

/** Constant-time comparison — HMAC verification must not leak timing information through early-exit comparison. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function verifyRndcEnvelope(
  envelope: RndcWireEnvelope,
  algorithm: string,
  secretBase64: string,
): boolean {
  try {
    return timingSafeEqual(signRndcPayload(envelope.payload, algorithm, secretBase64), envelope.hmac);
  } catch {
    return false;
  }
}

export function signRndcEnvelope(
  payload: RndcRequest | RndcResponse,
  algorithm: string,
  secretBase64: string,
): RndcWireEnvelope {
  return { hmac: signRndcPayload(payload, algorithm, secretBase64), payload };
}

const LENGTH_PREFIX_BYTES = 4;

/** Frames one envelope as `uint32 length` (big-endian) + UTF-8 JSON body. */
export function encodeRndcEnvelope(envelope: RndcWireEnvelope): Uint8Array {
  const body = utf8ToBytes(JSON.stringify(envelope));
  const framed = new Uint8Array(LENGTH_PREFIX_BYTES + body.length);
  new DataView(framed.buffer).setUint32(0, body.length, false);
  framed.set(body, LENGTH_PREFIX_BYTES);
  return framed;
}

export interface RndcDecodeResult {
  readonly envelope: RndcWireEnvelope;
  /** Bytes consumed from the input buffer — the caller slices the remainder for the next frame. */
  readonly consumed: number;
}

function isValidPayload(value: unknown): value is RndcRequest | RndcResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.nonce !== 'number') return false;
  if (typeof v.command === 'string') return true;
  return typeof v.result === 'number' && typeof v.text === 'string';
}

function isValidEnvelope(value: unknown): value is RndcWireEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.hmac === 'string' && isValidPayload(v.payload);
}

/**
 * Decodes one length-prefixed envelope from the front of `bytes`.
 * Returns `null` when the buffer doesn't yet hold a complete frame (the
 * caller should keep buffering incoming TCP data) — never throws on
 * incomplete input, only on a complete-but-malformed frame.
 */
export function decodeRndcEnvelope(bytes: Uint8Array): RndcDecodeResult | null {
  if (bytes.length < LENGTH_PREFIX_BYTES) return null;
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, false);
  const total = LENGTH_PREFIX_BYTES + length;
  if (bytes.length < total) return null;

  const body = bytes.subarray(LENGTH_PREFIX_BYTES, total);
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytesToUtf8(body));
  } catch {
    throw new Error('rndc: malformed message (invalid JSON)');
  }
  if (!isValidEnvelope(parsed)) {
    throw new Error('rndc: malformed message (unexpected shape)');
  }
  return { envelope: parsed, consumed: total };
}

/**
 * PRD-Nslookup-Dig-Rndc-Runas.md §4.1 / P7 — RndcWireCodec.ts: pure encode/
 * decode + HMAC signing for the real rndc wire protocol (no I/O; that's
 * RndcClient.ts/RndcServer.ts in P8/P9).
 */
import { describe, it, expect } from 'vitest';
import {
  signRndcPayload, verifyRndcEnvelope, signRndcEnvelope,
  encodeRndcEnvelope, decodeRndcEnvelope, isSupportedRndcAlgorithm,
} from '@/network/devices/linux/bind9/RndcWireCodec';
import type { RndcRequest, RndcResponse } from '@/network/devices/linux/bind9/RndcWireCodec';

const SECRET_B64 = 'c2VjcmV0'; // base64("secret")

describe('isSupportedRndcAlgorithm', () => {
  it('accepts hmac-md5 and hmac-sha256', () => {
    expect(isSupportedRndcAlgorithm('hmac-md5')).toBe(true);
    expect(isSupportedRndcAlgorithm('hmac-sha256')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isSupportedRndcAlgorithm('hmac-sha1')).toBe(false);
    expect(isSupportedRndcAlgorithm('')).toBe(false);
  });
});

describe('signRndcPayload / verifyRndcEnvelope', () => {
  const request: RndcRequest = { nonce: 1, command: 'status' };

  it('produces a deterministic hex HMAC for the same payload+key+algorithm', () => {
    const a = signRndcPayload(request, 'hmac-sha256', SECRET_B64);
    const b = signRndcPayload(request, 'hmac-sha256', SECRET_B64);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hmac-md5 produces a 32-hex-char digest', () => {
    const sig = signRndcPayload(request, 'hmac-md5', SECRET_B64);
    expect(sig).toMatch(/^[0-9a-f]{32}$/);
  });

  it('differs for a different key', () => {
    const a = signRndcPayload(request, 'hmac-sha256', SECRET_B64);
    const b = signRndcPayload(request, 'hmac-sha256', 'd3JvbmdrZXk=');
    expect(a).not.toBe(b);
  });

  it('differs for a different payload (nonce or command)', () => {
    const a = signRndcPayload(request, 'hmac-sha256', SECRET_B64);
    const b = signRndcPayload({ nonce: 2, command: 'status' }, 'hmac-sha256', SECRET_B64);
    const c = signRndcPayload({ nonce: 1, command: 'reload' }, 'hmac-sha256', SECRET_B64);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('throws for an unsupported algorithm', () => {
    expect(() => signRndcPayload(request, 'hmac-sha1', SECRET_B64)).toThrow(/unsupported key algorithm/);
  });

  it('verifyRndcEnvelope accepts a correctly signed envelope and rejects a tampered one', () => {
    const envelope = signRndcEnvelope(request, 'hmac-sha256', SECRET_B64);
    expect(verifyRndcEnvelope(envelope, 'hmac-sha256', SECRET_B64)).toBe(true);

    const tampered = { ...envelope, payload: { nonce: 1, command: 'stop' } };
    expect(verifyRndcEnvelope(tampered, 'hmac-sha256', SECRET_B64)).toBe(false);

    expect(verifyRndcEnvelope(envelope, 'hmac-sha256', 'd3JvbmdrZXk=')).toBe(false);
  });

  it('verifyRndcEnvelope returns false (not throw) for an unsupported algorithm', () => {
    const envelope = signRndcEnvelope(request, 'hmac-sha256', SECRET_B64);
    expect(verifyRndcEnvelope(envelope, 'hmac-sha1', SECRET_B64)).toBe(false);
  });
});

describe('encodeRndcEnvelope / decodeRndcEnvelope', () => {
  it('round-trips a request envelope', () => {
    const request: RndcRequest = { nonce: 42, command: 'reload zone1' };
    const envelope = signRndcEnvelope(request, 'hmac-sha256', SECRET_B64);
    const bytes = encodeRndcEnvelope(envelope);

    const decoded = decodeRndcEnvelope(bytes);
    expect(decoded).not.toBeNull();
    expect(decoded!.consumed).toBe(bytes.length);
    expect(decoded!.envelope).toEqual(envelope);
    expect(verifyRndcEnvelope(decoded!.envelope, 'hmac-sha256', SECRET_B64)).toBe(true);
  });

  it('round-trips a response envelope', () => {
    const response: RndcResponse = { nonce: 42, result: 0, text: 'server reload successful' };
    const envelope = signRndcEnvelope(response, 'hmac-sha256', SECRET_B64);
    const bytes = encodeRndcEnvelope(envelope);

    const decoded = decodeRndcEnvelope(bytes);
    expect(decoded!.envelope.payload).toEqual(response);
  });

  it('returns null (not throw) when the buffer holds less than the length prefix', () => {
    expect(decodeRndcEnvelope(new Uint8Array([0, 0]))).toBeNull();
  });

  it('returns null when the length prefix promises more bytes than are buffered yet (streaming TCP)', () => {
    const envelope = signRndcEnvelope({ nonce: 1, command: 'status' }, 'hmac-sha256', SECRET_B64);
    const full = encodeRndcEnvelope(envelope);
    const partial = full.subarray(0, full.length - 5);
    expect(decodeRndcEnvelope(partial)).toBeNull();
  });

  it('decodes exactly one frame and reports how many bytes to slice off for the next one', () => {
    const e1 = signRndcEnvelope({ nonce: 1, command: 'status' }, 'hmac-sha256', SECRET_B64);
    const e2 = signRndcEnvelope({ nonce: 2, command: 'reload' }, 'hmac-sha256', SECRET_B64);
    const combined = new Uint8Array([...encodeRndcEnvelope(e1), ...encodeRndcEnvelope(e2)]);

    const first = decodeRndcEnvelope(combined);
    expect(first!.envelope.payload).toEqual(e1.payload);

    const second = decodeRndcEnvelope(combined.subarray(first!.consumed));
    expect(second!.envelope.payload).toEqual(e2.payload);
  });

  it('throws on a complete-but-malformed frame (invalid JSON)', () => {
    const body = new TextEncoder().encode('not json');
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length, false);
    framed.set(body, 4);
    expect(() => decodeRndcEnvelope(framed)).toThrow(/malformed message/);
  });

  it('throws on a complete-but-wrong-shape frame (valid JSON, not an envelope)', () => {
    const body = new TextEncoder().encode(JSON.stringify({ foo: 'bar' }));
    const framed = new Uint8Array(4 + body.length);
    new DataView(framed.buffer).setUint32(0, body.length, false);
    framed.set(body, 4);
    expect(() => decodeRndcEnvelope(framed)).toThrow(/malformed message/);
  });
});

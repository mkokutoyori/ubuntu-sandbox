/**
 * PRD-HTTP.md §5 P5 — HTTP authentication: Basic (RFC 7617) and Digest
 * (RFC 7616, MD5 and SHA-256) — including the classic RFC 2617/7616
 * Appendix B test vectors, cross-checked against Node's own `crypto`
 * module before use here to confirm `@/crypto/hash`'s md5Hex/sha256Hex
 * are bit-exact (no cryptographic primitive is duplicated).
 */
import { describe, it, expect } from 'vitest';
import {
  buildBasicChallengeHeader,
  encodeBasicCredentials,
  parseBasicCredentials,
  verifyBasicCredentials,
} from '@/network/http/auth/BasicAuth';
import {
  buildDigestChallengeHeader,
  parseDigestChallenge,
  computeDigestResponse,
  buildDigestAuthorizationHeader,
  parseDigestCredentials,
  verifyDigestCredentials,
  DigestNonceTracker,
  type DigestChallenge,
} from '@/network/http/auth/DigestAuth';

describe('Basic auth (RFC 7617)', () => {
  it('builds a WWW-Authenticate challenge header', () => {
    expect(buildBasicChallengeHeader({ scheme: 'Basic', realm: 'protected' })).toBe('Basic realm="protected"');
  });

  it('encodes and parses credentials round-trip', () => {
    const header = encodeBasicCredentials('arthur', 'hunter2');
    expect(header).toMatch(/^Basic [A-Za-z0-9+/=]+$/);
    expect(parseBasicCredentials(header)).toEqual({ username: 'arthur', password: 'hunter2' });
  });

  it('handles a password containing a colon', () => {
    const header = encodeBasicCredentials('arthur', 'a:b:c');
    expect(parseBasicCredentials(header)).toEqual({ username: 'arthur', password: 'a:b:c' });
  });

  it('verifies correct credentials and rejects incorrect ones', () => {
    const header = encodeBasicCredentials('arthur', 'hunter2');
    expect(verifyBasicCredentials(header, 'arthur', 'hunter2')).toBe(true);
    expect(verifyBasicCredentials(header, 'arthur', 'wrong')).toBe(false);
  });

  it('rejects a malformed header', () => {
    expect(parseBasicCredentials('Bearer xyz')).toBeNull();
    expect(parseBasicCredentials('Basic not-valid-base64!!!')).toBeNull();
  });
});

describe('Digest auth (RFC 7616) — challenge round-trip', () => {
  it('builds and parses a challenge header', () => {
    const challenge: DigestChallenge = { scheme: 'Digest', realm: 'testrealm@host.com', nonce: 'abc123', qop: 'auth', algorithm: 'MD5', opaque: 'op123' };
    const header = buildDigestChallengeHeader(challenge);
    const parsed = parseDigestChallenge(header);
    expect(parsed).toEqual(challenge);
  });

  it('defaults algorithm to MD5 when absent', () => {
    const parsed = parseDigestChallenge('Digest realm="r", nonce="n"');
    expect(parsed?.algorithm).toBe('MD5');
  });
});

describe('Digest auth — RFC 2617/7616 Appendix B official test vectors', () => {
  it('computes the classic MD5 vector correctly', () => {
    const response = computeDigestResponse({
      username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html',
      realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
      nc: '00000001', cnonce: '0a4f113b', algorithm: 'MD5',
    });
    expect(response).toBe('6629fae49393a05397450978507c4ef1');
  });

  it('computes the RFC 7616 SHA-256 vector correctly', () => {
    const response = computeDigestResponse({
      username: 'Mufasa', password: 'Circle of Life', method: 'GET', uri: '/dir/index.html',
      realm: 'http-auth@example.org', nonce: '7ypf/xlj9XXwfDPEoM4URrv/xwf94BcCAzFZH4GiTo0v',
      nc: '00000001', cnonce: 'f2/wE4q74E6zIJEtWaHKaf5wv/H5QzzpXusqGemxURZJ', algorithm: 'SHA-256',
    });
    expect(response).toBe('753927fa0e85d155564e2e272a28d1802ca10daf4496794697cf8db5856cb6c1');
  });
});

describe('Digest auth — client build / server verify round-trip', () => {
  it('a header built by the client verifies successfully server-side (MD5)', () => {
    const challenge: DigestChallenge = { scheme: 'Digest', realm: 'testrealm@host.com', nonce: 'n0nce', qop: 'auth', algorithm: 'MD5' };
    const header = buildDigestAuthorizationHeader({
      username: 'arthur', password: 'hunter2', method: 'GET', uri: '/secret', challenge, cnonce: 'c0nonce', nc: '00000001',
    });
    const creds = parseDigestCredentials(header)!;
    expect(verifyDigestCredentials(creds, 'GET', 'hunter2')).toBe(true);
    expect(verifyDigestCredentials(creds, 'GET', 'wrongpass')).toBe(false);
  });

  it('a header built by the client verifies successfully server-side (SHA-256)', () => {
    const challenge: DigestChallenge = { scheme: 'Digest', realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'SHA-256' };
    const header = buildDigestAuthorizationHeader({
      username: 'arthur', password: 'hunter2', method: 'POST', uri: '/api', challenge, cnonce: 'cn', nc: '00000001',
    });
    const creds = parseDigestCredentials(header)!;
    expect(creds.algorithm).toBe('SHA-256');
    expect(verifyDigestCredentials(creds, 'POST', 'hunter2')).toBe(true);
  });

  it('a mismatched method fails verification (response bound to method+uri)', () => {
    const challenge: DigestChallenge = { scheme: 'Digest', realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'MD5' };
    const header = buildDigestAuthorizationHeader({
      username: 'arthur', password: 'hunter2', method: 'GET', uri: '/secret', challenge, cnonce: 'c', nc: '00000001',
    });
    const creds = parseDigestCredentials(header)!;
    expect(verifyDigestCredentials(creds, 'POST', 'hunter2')).toBe(false);
  });

  it('rejects a header missing required fields', () => {
    expect(parseDigestCredentials('Digest username="arthur"')).toBeNull();
    expect(parseDigestCredentials('Basic abc123')).toBeNull();
  });
});

describe('DigestNonceTracker — replay detection (RFC 7616 §5.10)', () => {
  it('accepts strictly increasing nc for the same nonce', () => {
    const tracker = new DigestNonceTracker();
    expect(tracker.isReplay('nonceA', '00000001')).toBe(false);
    expect(tracker.isReplay('nonceA', '00000002')).toBe(false);
  });

  it('flags a repeated nc for the same nonce as a replay', () => {
    const tracker = new DigestNonceTracker();
    expect(tracker.isReplay('nonceA', '00000001')).toBe(false);
    expect(tracker.isReplay('nonceA', '00000001')).toBe(true);
  });

  it('flags a decreasing nc for the same nonce as a replay', () => {
    const tracker = new DigestNonceTracker();
    expect(tracker.isReplay('nonceA', '00000005')).toBe(false);
    expect(tracker.isReplay('nonceA', '00000003')).toBe(true);
  });

  it('tracks nc independently per nonce', () => {
    const tracker = new DigestNonceTracker();
    expect(tracker.isReplay('nonceA', '00000005')).toBe(false);
    expect(tracker.isReplay('nonceB', '00000001')).toBe(false);
  });
});

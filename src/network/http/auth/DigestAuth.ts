import { md5Hex, sha256Hex } from '@/crypto/hash';

export type DigestAlgorithm = 'MD5' | 'SHA-256';

export interface DigestChallenge {
  scheme: 'Digest';
  realm: string;
  nonce: string;
  opaque?: string;
  qop: 'auth';
  algorithm: DigestAlgorithm;
}

export interface DigestCredentials {
  username: string;
  realm: string;
  nonce: string;
  uri: string;
  response: string;
  cnonce: string;
  nc: string;
  qop: 'auth';
  algorithm: DigestAlgorithm;
  opaque?: string;
}

function hashFor(algorithm: DigestAlgorithm): (text: string) => string {
  return algorithm === 'SHA-256' ? sha256Hex : md5Hex;
}

function parseParams(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(header)) !== null) {
    result[match[1]] = match[2] !== undefined ? match[2] : match[3];
  }
  return result;
}

export function buildDigestChallengeHeader(challenge: DigestChallenge): string {
  const parts = [
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `qop="auth"`,
    `algorithm=${challenge.algorithm}`,
  ];
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export function parseDigestChallenge(header: string): DigestChallenge | null {
  if (!/^Digest\s/i.test(header.trim())) return null;
  const params = parseParams(header);
  if (!params.realm || !params.nonce) return null;
  return {
    scheme: 'Digest',
    realm: params.realm,
    nonce: params.nonce,
    opaque: params.opaque,
    qop: 'auth',
    algorithm: params.algorithm === 'SHA-256' ? 'SHA-256' : 'MD5',
  };
}

// RFC 7616 §3.4.1/§3.4.2 — HA1/HA2/response computation.
export function computeDigestResponse(opts: {
  username: string;
  password: string;
  method: string;
  uri: string;
  realm: string;
  nonce: string;
  nc: string;
  cnonce: string;
  algorithm: DigestAlgorithm;
}): string {
  const hash = hashFor(opts.algorithm);
  const ha1 = hash(`${opts.username}:${opts.realm}:${opts.password}`);
  const ha2 = hash(`${opts.method}:${opts.uri}`);
  return hash(`${ha1}:${opts.nonce}:${opts.nc}:${opts.cnonce}:auth:${ha2}`);
}

export function buildDigestAuthorizationHeader(opts: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  cnonce: string;
  nc: string;
}): string {
  const response = computeDigestResponse({
    username: opts.username, password: opts.password, method: opts.method, uri: opts.uri,
    realm: opts.challenge.realm, nonce: opts.challenge.nonce, nc: opts.nc, cnonce: opts.cnonce,
    algorithm: opts.challenge.algorithm,
  });
  const parts = [
    `username="${opts.username}"`,
    `realm="${opts.challenge.realm}"`,
    `nonce="${opts.challenge.nonce}"`,
    `uri="${opts.uri}"`,
    `qop=auth`,
    `nc=${opts.nc}`,
    `cnonce="${opts.cnonce}"`,
    `response="${response}"`,
    `algorithm=${opts.challenge.algorithm}`,
  ];
  if (opts.challenge.opaque) parts.push(`opaque="${opts.challenge.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export function parseDigestCredentials(authorizationHeader: string): DigestCredentials | null {
  if (!/^Digest\s/i.test(authorizationHeader.trim())) return null;
  const params = parseParams(authorizationHeader);
  const required = ['username', 'realm', 'nonce', 'uri', 'response', 'cnonce', 'nc'];
  for (const key of required) if (!params[key]) return null;
  return {
    username: params.username,
    realm: params.realm,
    nonce: params.nonce,
    uri: params.uri,
    response: params.response,
    cnonce: params.cnonce,
    nc: params.nc,
    qop: 'auth',
    algorithm: params.algorithm === 'SHA-256' ? 'SHA-256' : 'MD5',
    opaque: params.opaque,
  };
}

export function verifyDigestCredentials(creds: DigestCredentials, method: string, password: string): boolean {
  const expected = computeDigestResponse({
    username: creds.username, password, method, uri: creds.uri,
    realm: creds.realm, nonce: creds.nonce, nc: creds.nc, cnonce: creds.cnonce,
    algorithm: creds.algorithm,
  });
  return expected === creds.response;
}

/**
 * RFC 7616 §5.10 — a server tracks the highest nonce-count seen per nonce;
 * a repeated or decreasing `nc` for the same nonce is a replay.
 */
export class DigestNonceTracker {
  private highestNc = new Map<string, number>();

  isReplay(nonce: string, nc: string): boolean {
    const n = parseInt(nc, 16);
    const last = this.highestNc.get(nonce) ?? 0;
    if (isNaN(n) || n <= last) return true;
    this.highestNc.set(nonce, n);
    return false;
  }
}

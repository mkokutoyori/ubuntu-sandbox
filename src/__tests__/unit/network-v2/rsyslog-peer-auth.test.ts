/**
 * Probe - src/network/rsyslog/engine/PeerAuth.ts, ported from runtime/nsd_gtls.c (gtlsChkPeerAuth, gtlsChkPeerName,
 * gtlsChkPeerFingerprint, gtlsChkPeerCertValidity) and runtime/net.c (PermittedPeerWildcardMatch).
 *
 * Measured against the base commit: the module does not exist, every case fails at import. There is no witness; the lab
 * is a pure function, the only environment is the certificate view handed to it.
 */
import { describe, expect, it } from 'vitest';
import { authorizePeer, parseAuthMode, parsePermitExpired, permittedPeerMatches, type PeerAuthPolicy, type PeerCertificateView } from '@/network/rsyslog/engine/PeerAuth';
import { RS_RET } from '@/network/rsyslog/engine/Log';
import type { RuntimeLog } from '@/network/rsyslog/engine/Modules';

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);

function recorder(): { runtime: RuntimeLog; lines: string[] } {
  const lines: string[] = [];
  const runtime: RuntimeLog = {
    error: (text, code) => { lines.push(`error ${code ?? ''}: ${text}`); },
    warning: (text) => { lines.push(`warning: ${text}`); },
    info: (text) => { lines.push(`info: ${text}`); },
    log: (severity, _code, text) => { lines.push(`log ${severity}: ${text}`); },
    internal: () => undefined,
    childExited: () => undefined,
  };
  return { runtime, lines };
}

const CERT: PeerCertificateView = {
  fingerprintSha1: 'SHA1:AA:BB:CC', fingerprintSha256: 'SHA256:11:22:33', dnsNames: ['central.example.net'], ipAddresses: ['10.0.0.50'],
  commonName: 'central', chain: 'valid', activationTimesMs: [NOW - 86_400_000], description: 'peer provided 1 certificate(s).',
};

function policy(overrides: Partial<PeerAuthPolicy>): PeerAuthPolicy {
  return { authMode: 'x509/name', permittedPeers: [], connectHost: null, permitExpiredCerts: 'off', prioritizeSan: false, crlNextUpdateMs: null, ...overrides };
}

function check(policyValue: PeerAuthPolicy, certificate: PeerCertificateView | null): { code: number; lines: string[] } {
  const { runtime, lines } = recorder();
  const code = authorizePeer(policyValue, certificate, { runtime, nowMs: NOW, remoteName: 'central.example.net', reportAuthError: true });
  return { code, lines };
}

describe('permitted peer wildcards', () => {
  it('matches a leading wildcard component by suffix and refuses a different depth', () => {
    expect(permittedPeerMatches('*.example.net', 'host.example.net')).toBe(true);
    expect(permittedPeerMatches('*.example.net', 'example.net')).toBe(false);
    expect(permittedPeerMatches('*.example.net', 'a.b.example.net')).toBe(false);
    expect(permittedPeerMatches('*.example.net', 'host.example.org')).toBe(false);
  });

  it('matches a component prefix, a component suffix and a plain name exactly', () => {
    expect(permittedPeerMatches('log*.example.net', 'logger1.example.net')).toBe(true);
    expect(permittedPeerMatches('log*.example.net', 'syslog.example.net')).toBe(false);
    expect(permittedPeerMatches('*host.example.net', 'myhost.example.net')).toBe(true);
    expect(permittedPeerMatches('central', 'central')).toBe(true);
    expect(permittedPeerMatches('central', 'central2')).toBe(false);
  });

  it('refuses a wildcard that does not stand at an end of its component', () => {
    expect(permittedPeerMatches('a*b.example.net', 'axb.example.net')).toBe(false);
  });
});

describe('authentication modes', () => {
  it('parses the driver vocabulary and defaults to x509/name', () => {
    expect(parseAuthMode(null)).toBe('x509/name');
    expect(parseAuthMode('X509/CertValid')).toBe('x509/certvalid');
    expect(parseAuthMode('kerberos')).toBeNull();
    expect(parsePermitExpired(null)).toBe('off');
    expect(parsePermitExpired('maybe')).toBeNull();
  });

  it('anon accepts anything, even no certificate', () => {
    expect(check(policy({ authMode: 'anon' }), null).code).toBe(RS_RET.NO_ERRCODE);
  });

  it('x509/name accepts a dNSName in the permitted list and reports every name it saw on refusal', () => {
    expect(check(policy({ permittedPeers: ['*.example.net'] }), CERT).code).toBe(RS_RET.NO_ERRCODE);
    const refused = check(policy({ permittedPeers: ['other.example.org'] }), CERT);
    expect(refused.code).toBe(RS_RET.INVALID_FINGERPRINT);
    expect(refused.lines[0]).toContain('error: peer name not authorized -  not permitted to talk to it. Names: DNSname: central.example.net; IPaddress: 10.0.0.50; CN: central; ');
  });

  it('x509/name falls back to the connect host when no peer is configured', () => {
    expect(check(policy({ connectHost: 'central.example.net' }), CERT).code).toBe(RS_RET.NO_ERRCODE);
    expect(check(policy({ connectHost: 'other' }), CERT).code).toBe(RS_RET.INVALID_FINGERPRINT);
  });

  it('prioritizeSan ignores the common name when a SAN exists', () => {
    const sanOnly = policy({ permittedPeers: ['central'], prioritizeSan: true });
    expect(check(sanOnly, CERT).code).toBe(RS_RET.INVALID_FINGERPRINT);
    expect(check({ ...sanOnly, prioritizeSan: false }, CERT).code).toBe(RS_RET.NO_ERRCODE);
  });

  it('an embedded NUL in a dNSName never matches its prefix', () => {
    const hostile: PeerCertificateView = { ...CERT, dnsNames: ['central\u0000.evil.example'], ipAddresses: [], commonName: null };
    const refused = check(policy({ permittedPeers: ['central'] }), hostile);
    expect(refused.code).toBe(RS_RET.INVALID_FINGERPRINT);
    expect(refused.lines[0]).toContain('DNSname: <invalid>;');
  });

  it('x509/fingerprint matches the SHA1 or the SHA256 form and states the SHA1 one on refusal', () => {
    expect(check(policy({ authMode: 'x509/fingerprint', permittedPeers: ['SHA256:11:22:33'] }), CERT).code).toBe(RS_RET.NO_ERRCODE);
    const refused = check(policy({ authMode: 'x509/fingerprint', permittedPeers: ['SHA1:00'] }), CERT);
    expect(refused.code).toBe(RS_RET.INVALID_FINGERPRINT);
    expect(refused.lines[0]).toContain("error: peer fingerprint 'SHA1:AA:BB:CC' unknown - we are not permitted to talk to it");
  });

  it('a peer without a certificate is refused with the driver wording', () => {
    const refused = check(policy({ authMode: 'x509/fingerprint', permittedPeers: ['SHA1:AA:BB:CC'] }), null);
    expect(refused.code).toBe(RS_RET.TLS_NO_CERT);
    expect(refused.lines[0]).toContain('peer central.example.net did not provide a certificate, not permitted to talk to it');
  });
});

describe('certificate validity', () => {
  it('x509/certvalid names the reason of an invalid chain and prints the certificate description', () => {
    const unknownSigner: PeerCertificateView = { ...CERT, chain: 'signer-not-found' };
    const refused = check(policy({ authMode: 'x509/certvalid' }), unknownSigner);
    expect(refused.code).toBe(RS_RET.CERT_INVALID);
    expect(refused.lines).toEqual([
      "error -1: not permitted to talk to peer 'central.example.net', certificate invalid: signer not found",
      'error -1: invalid cert info: peer provided 1 certificate(s).',
    ]);
  });

  it('an expired certificate is refused at off, tolerated at warn (with a warning) and at on', () => {
    const expired: PeerCertificateView = { ...CERT, chain: 'expired' };
    expect(check(policy({ authMode: 'x509/certvalid' }), expired).code).toBe(RS_RET.CERT_EXPIRED);
    const warned = check(policy({ authMode: 'x509/certvalid', permitExpiredCerts: 'warn' }), expired);
    expect(warned.code).toBe(RS_RET.NO_ERRCODE);
    expect(warned.lines).toEqual(['log 4: Warning, certificate expired but expired certs are permitted']);
    expect(check(policy({ authMode: 'x509/certvalid', permitExpiredCerts: 'on' }), expired).code).toBe(RS_RET.NO_ERRCODE);
  });

  it('a revoked certificate has its own code', () => {
    expect(check(policy({ authMode: 'x509/certvalid' }), { ...CERT, chain: 'revoked' }).code).toBe(RS_RET.CERT_REVOKED);
  });

  it('a certificate in the chain that is not yet active is refused, whatever the chain verdict', () => {
    const future: PeerCertificateView = { ...CERT, activationTimesMs: [NOW - 1000, NOW + 86_400_000] };
    const refused = check(policy({ authMode: 'x509/certvalid' }), future);
    expect(refused.code).toBe(RS_RET.CERT_NOT_YET_ACTIVE);
    expect(refused.lines[0]).toContain('certificate 1 not yet active');
  });

  it('a CRL past its nextUpdate rejects every peer, anon included', () => {
    const refused = check(policy({ authMode: 'anon', crlNextUpdateMs: NOW - 1 }), CERT);
    expect(refused.code).toBe(RS_RET.CRL_INVALID);
    expect(refused.lines[0]).toContain("CRL has expired (nextUpdate passed), rejecting peer 'central.example.net'");
  });

  it('x509/name checks validity before the name', () => {
    const refused = check(policy({ permittedPeers: ['central.example.net'] }), { ...CERT, chain: 'signer-not-ca' });
    expect(refused.code).toBe(RS_RET.CERT_INVALID);
    expect(refused.lines[0]).toContain('signer is not a CA');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { EapTlsServerSession } from '@/network/radius/eaptls/EapTlsServerSession';
import { EapTlsPeerSession } from '@/network/radius/eaptls/EapTlsPeerSession';
import type { EapPacket } from '@/network/radius/eap';

const NOW = Date.now();

function issuedPair(ca: CertificateAuthority, subject: string) {
  return ca.issueCertificate({ subject, notBefore: NOW - 1000, notAfter: NOW + 365 * 24 * 3600 * 1000 });
}

/** Drives a full EAP-TLS conversation to completion, returning both sides' terminal state. Fragmentation-agnostic: each iteration is one round trip regardless of how many are needed. */
function runHandshake(server: EapTlsServerSession, peer: EapTlsPeerSession): { serverResult: string | null; peerResult: string | null; rounds: number } {
  let req: EapPacket = server.start(1);
  let rounds = 0;
  while (server.result === null) {
    rounds++;
    // RFC 8446 flights carry a full certificate chain + signature, so a
    // tiny 40-byte MTU now needs noticeably more fragments/rounds than the
    // old ad hoc 2-RTT model did — 150 comfortably covers that case.
    if (rounds > 150) throw new Error('handshake did not converge');
    const resp = peer.handle(req);
    req = server.handle(resp);
  }
  return { serverResult: server.result, peerResult: peer.result, rounds };
}

describe('EAP-TLS handshake (RFC 5216) — direct server/peer session FSM', () => {
  let ca: CertificateAuthority;
  let otherCa: CertificateAuthority;

  beforeEach(() => {
    ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    otherCa = CertificateAuthority.generate('CN=other-ca', { now: NOW });
  });

  it('accepts a client whose certificate chains to the trusted CA', () => {
    const serverIssued = issuedPair(ca, 'CN=radius-server');
    const clientIssued = issuedPair(ca, 'CN=alice');
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new EapTlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey, verifier });
    const peer = new EapTlsPeerSession(clientIssued.cert, verifier, { clientPrivateKey: clientIssued.privateKey });

    const { serverResult, peerResult } = runHandshake(server, peer);
    expect(serverResult).toBe('accept');
    expect(peerResult).toBe('success');
  });

  it('rejects a client certificate issued by an untrusted CA', () => {
    const serverIssued = issuedPair(ca, 'CN=radius-server');
    const clientIssued = issuedPair(otherCa, 'CN=alice');
    const serverVerifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    const peerVerifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new EapTlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey, verifier: serverVerifier });
    const peer = new EapTlsPeerSession(clientIssued.cert, peerVerifier, { clientPrivateKey: clientIssued.privateKey });

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('reject');
  });

  it('the peer rejects a server certificate issued by an untrusted CA (no cert forced through)', () => {
    const serverIssued = issuedPair(otherCa, 'CN=radius-server');
    const clientIssued = issuedPair(ca, 'CN=alice');
    const serverVerifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    const peerVerifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new EapTlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey, verifier: serverVerifier });
    const peer = new EapTlsPeerSession(clientIssued.cert, peerVerifier, { clientPrivateKey: clientIssued.privateKey });

    // The peer detects the bad server cert once its (possibly fragmented)
    // flight fully arrives and stops cooperating — from the server's
    // perspective, a malformed/empty "client flight" is a clean reject
    // rather than a crash.
    let req: EapPacket = server.start(1);
    let rounds = 0;
    while (peer.result === null && server.result === null) {
      rounds++;
      if (rounds > 50) throw new Error('did not converge');
      const resp = peer.handle(req);
      req = server.handle(resp);
    }
    expect(peer.result).toBe('failure');
    expect(server.result).toBe('reject');
  });

  it('rejects a client with no certificate when one is required', () => {
    const serverIssued = issuedPair(ca, 'CN=radius-server');
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new EapTlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey, verifier, requireClientCert: true });
    const peer = new EapTlsPeerSession(null, verifier);

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('reject');
  });

  it('rejects an expired client certificate', () => {
    const serverIssued = issuedPair(ca, 'CN=radius-server');
    const expiredClient = ca.issueCertificate({ subject: 'CN=alice', notBefore: NOW - 20000, notAfter: NOW - 10000 });
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new EapTlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey, verifier });
    const peer = new EapTlsPeerSession(expiredClient.cert, verifier, { clientPrivateKey: expiredClient.privateKey });

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('reject');
  });

  it('completes a multi-fragment handshake when the MTU forces fragmentation of every flight', () => {
    const serverIssued = issuedPair(ca, 'CN=radius-server');
    const clientIssued = issuedPair(ca, 'CN=alice');
    const verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });

    const server = new EapTlsServerSession({ serverCert: serverIssued.cert, serverPrivateKey: serverIssued.privateKey, verifier, mtu: 40 });
    const peer = new EapTlsPeerSession(clientIssued.cert, verifier, { mtu: 40, clientPrivateKey: clientIssued.privateKey });

    const { serverResult, peerResult, rounds } = runHandshake(server, peer);
    expect(serverResult).toBe('accept');
    expect(peerResult).toBe('success');
    // A tiny 40-byte MTU against a certificate-bearing flight must take
    // more round trips than the single-fragment default-MTU case.
    expect(rounds).toBeGreaterThan(5);
  });
});

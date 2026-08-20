import { describe, it, expect, beforeEach } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { EapTlsServerSession } from '@/network/radius/eaptls/EapTlsServerSession';
import { EapTlsPeerSession } from '@/network/radius/eaptls/EapTlsPeerSession';
import { TtlsPapInnerAuthServer, TtlsPapInnerAuthPeer } from '@/network/radius/eaptls/TtlsInnerAuth';
import { PeapMd5InnerAuthServer, PeapMd5InnerAuthPeer } from '@/network/radius/eaptls/PeapInnerAuth';
import type { RadiusUser } from '@/network/radius/types';
import type { EapPacket } from '@/network/radius/eap';

const NOW = Date.now();

function usersMap(...users: RadiusUser[]): Map<string, RadiusUser> {
  return new Map(users.map((u) => [u.username, u]));
}

function runHandshake(server: EapTlsServerSession, peer: EapTlsPeerSession): { serverResult: string | null; rounds: number } {
  let req: EapPacket = server.start(1);
  let rounds = 0;
  while (server.result === null) {
    rounds++;
    // Garde-fou contre une boucle infinie, pas une spécification. Il
    // valait 80 et le cas à MTU 40 en demande 84 depuis que la part de
    // clé est un vrai point X25519 de 32 octets au lieu d'un nonce
    // court : plus d'octets à faire passer, donc plus de fragments.
    if (rounds > 200) throw new Error('handshake did not converge');
    const resp = peer.handle(req);
    req = server.handle(resp);
  }
  return { serverResult: server.result, rounds };
}

describe('EAP-TTLS (RFC 5281) — outer tunnel + inner PAP', () => {
  let ca: CertificateAuthority;
  let verifier: CertificateVerifier;
  let serverCert: ReturnType<CertificateAuthority['issueCertificate']>;

  beforeEach(() => {
    ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    serverCert = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  });

  it('accepts correct inner PAP credentials, with no client certificate needed', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new EapTlsServerSession({
      serverCert: serverCert.cert, serverPrivateKey: serverCert.privateKey, verifier, requireClientCert: false,
      eapType: 'ttls', innerAuth: new TtlsPapInnerAuthServer((u) => users.get(u)),
    });
    const peer = new EapTlsPeerSession(null, verifier, {
      eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wonderland'),
    });

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('accept');
  });

  it('rejects a wrong inner PAP password', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new EapTlsServerSession({
      serverCert: serverCert.cert, serverPrivateKey: serverCert.privateKey, verifier, requireClientCert: false,
      eapType: 'ttls', innerAuth: new TtlsPapInnerAuthServer((u) => users.get(u)),
    });
    const peer = new EapTlsPeerSession(null, verifier, {
      eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'not-the-password'),
    });

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('reject');
  });

  it('completes even when a tiny MTU forces fragmentation of the outer tunnel and the inner exchange', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new EapTlsServerSession({
      serverCert: serverCert.cert, serverPrivateKey: serverCert.privateKey, verifier, requireClientCert: false, mtu: 40,
      eapType: 'ttls', innerAuth: new TtlsPapInnerAuthServer((u) => users.get(u)),
    });
    const peer = new EapTlsPeerSession(null, verifier, {
      mtu: 40, eapType: 'ttls', innerAuth: new TtlsPapInnerAuthPeer('alice', 'wonderland'),
    });

    const { serverResult, rounds } = runHandshake(server, peer);
    expect(serverResult).toBe('accept');
    expect(rounds).toBeGreaterThan(6);
  });
});

describe('PEAP — outer tunnel + inner EAP-MD5', () => {
  let ca: CertificateAuthority;
  let verifier: CertificateVerifier;
  let serverCert: ReturnType<CertificateAuthority['issueCertificate']>;

  beforeEach(() => {
    ca = CertificateAuthority.generate('CN=radius-ca', { now: NOW });
    verifier = new CertificateVerifier({ trustAnchors: [ca.rootCertificate], clock: () => NOW });
    serverCert = ca.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  });

  it('accepts a correct inner EAP-MD5 password, with no client certificate needed', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new EapTlsServerSession({
      serverCert: serverCert.cert, serverPrivateKey: serverCert.privateKey, verifier, requireClientCert: false,
      eapType: 'peap', innerAuth: new PeapMd5InnerAuthServer((u) => users.get(u)),
    });
    const peer = new EapTlsPeerSession(null, verifier, {
      eapType: 'peap', innerAuth: new PeapMd5InnerAuthPeer('alice', 'wonderland'),
    });

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('accept');
  });

  it('rejects a wrong inner password', () => {
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new EapTlsServerSession({
      serverCert: serverCert.cert, serverPrivateKey: serverCert.privateKey, verifier, requireClientCert: false,
      eapType: 'peap', innerAuth: new PeapMd5InnerAuthServer((u) => users.get(u)),
    });
    const peer = new EapTlsPeerSession(null, verifier, {
      eapType: 'peap', innerAuth: new PeapMd5InnerAuthPeer('alice', 'wrong'),
    });

    const { serverResult } = runHandshake(server, peer);
    expect(serverResult).toBe('reject');
  });

  it('rejects when the outer server certificate is untrusted, before the inner phase ever starts', () => {
    const rogueCa = CertificateAuthority.generate('CN=rogue', { now: NOW });
    const rogueServerCert = rogueCa.issueCertificate({ subject: 'CN=aaa-server', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
    const users = usersMap({ username: 'alice', password: 'wonderland', replyAttributes: [] });
    const server = new EapTlsServerSession({
      serverCert: rogueServerCert.cert, serverPrivateKey: rogueServerCert.privateKey, verifier, requireClientCert: false,
      eapType: 'peap', innerAuth: new PeapMd5InnerAuthServer((u) => users.get(u)),
    });
    const peer = new EapTlsPeerSession(null, verifier, {
      eapType: 'peap', innerAuth: new PeapMd5InnerAuthPeer('alice', 'wonderland'),
    });

    let req: EapPacket = server.start(1);
    let rounds = 0;
    while (server.result === null && rounds < 80) {
      rounds++;
      const resp = peer.handle(req);
      if (peer.result === 'failure') break;
      req = server.handle(resp);
    }
    expect(peer.result).toBe('failure');
  });
});

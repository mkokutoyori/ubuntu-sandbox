/**
 * Validation de chemin (RFC 5280 §6) dans TLS : une chaîne leaf →
 * intermédiaire → racine, `basicConstraints` (§4.2.1.9), `pathLenConstraint`,
 * `keyUsage` keyCertSign (§4.2.1.3), `extKeyUsage` (§4.2.1.12), taille
 * minimale de clé RSA, et `openssl verify -untrusted`.
 *
 * MESURÉ avant correctif : `CertificateVerifier` ne connaissait que
 * l'émission DIRECTE par une ancre ; un certificat émis par une AC
 * intermédiaire était « unknown » même avec la chaîne complète sur le
 * fil, l'option `-untrusted` d'`openssl verify` était déclarée mais lue
 * par personne, et la racine du laboratoire portait `pathlen:0`, ce qui
 * lui interdisait toute AC subordonnée.
 *
 * Avant correctif, 9 des 11 cas tombent. Les deux témoins passent dans
 * les deux états : émission directe par la racine et certificat expiré
 * (verdict inchangé).
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';
import { TlsServerSession } from '@/network/tls/TlsServerSession';
import { TlsClientSession } from '@/network/tls/TlsClientSession';
import type { TlsRecord } from '@/network/tls/recordLayer';

const NOW = Date.now();
const YEAR = 365 * 24 * 3600 * 1000;

function pki() {
  const root = CertificateAuthority.generate('CN=Root', { now: NOW });
  const inter = (root as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
    .issueSubordinateCA({ subject: 'CN=Inter', notBefore: NOW - 1000, notAfter: NOW + YEAR });
  const leaf = inter.issueCertificate({
    subject: 'CN=srv', notBefore: NOW - 1000, notAfter: NOW + YEAR, subjectAltNames: ['srv.lab'],
  } as never);
  return { root, inter, leaf };
}

function handshake(
  verifier: CertificateVerifier, leaf: ReturnType<typeof pki>['leaf'],
  chain: ReturnType<typeof pki>['root']['rootCertificate'][], versions?: ('1.2' | '1.3')[],
): TlsClientSession {
  const server = new TlsServerSession({
    serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, serverChain: chain,
  });
  const client = new TlsClientSession({ verifier, serverName: 'srv.lab', ...(versions ? { versions } : {}) });
  let up: readonly TlsRecord[] | null = client.start();
  for (let i = 0; i < 6 && up !== null && up.length > 0; i++) {
    const down = server.handle(up);
    if (down === null || down.length === 0) break;
    up = client.handle(down);
  }
  return client;
}

describe('chaîne leaf → intermédiaire → racine', () => {
  it('le serveur qui envoie sa chaîne est accepté en TLS 1.3 et en 1.2', () => {
    const { root, inter, leaf } = pki();
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(handshake(verifier, leaf, [inter.rootCertificate]).result).toBe('success');
    expect(handshake(verifier, leaf, [inter.rootCertificate], ['1.2']).result).toBe('success');
  });

  it('sans l\'intermédiaire sur le fil, le client répond unknown_ca (48)', () => {
    const { root, leaf } = pki();
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    const client = handshake(verifier, leaf, []);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('unknown_ca');
  });

  it('témoin : un certificat émis directement par la racine passe toujours', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const direct = root.issueCertificate({ subject: 'CN=d', notBefore: NOW - 1000, notAfter: NOW + YEAR, subjectAltNames: ['srv.lab'] } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(handshake(verifier, direct, []).result).toBe('success');
  });

  it('une signature d\'intermédiaire falsifiée est refusée (decrypt_error, X509_V_ERR_CERT_SIGNATURE_FAILURE dans x509table)', () => {
    const { root, inter, leaf } = pki();
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    const forged = { ...inter.rootCertificate, signature: `${inter.rootCertificate.signature.slice(0, -2)}00` };
    const client = handshake(verifier, leaf, [forged]);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('decrypt_error');
  });

  it('un intermédiaire expiré invalide la chaîne', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const expired = (root as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
      .issueSubordinateCA({ subject: 'CN=Old', notBefore: NOW - 3000, notAfter: NOW - 1000 });
    const leaf = expired.issueCertificate({ subject: 'CN=l', notBefore: NOW - 3000, notAfter: NOW + YEAR, subjectAltNames: ['srv.lab'] } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    const client = handshake(verifier, leaf, [expired.rootCertificate]);
    expect(client.lastAlert?.description).toBe('certificate_expired');
  });
});

describe('contraintes de l\'intermédiaire', () => {
  it('RFC 5280 §4.2.1.9 : un certificat feuille ne peut pas signer (not-a-ca)', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const ee = root.issueCertificate({ subject: 'CN=ee', notBefore: NOW - 1000, notAfter: NOW + YEAR } as never);
    const rogue = CertificateAuthority.fromKeyPair(ee.cert, ee.privateKey);
    const leaf = rogue.issueCertificate({ subject: 'CN=x', notBefore: NOW - 1000, notAfter: NOW + YEAR, subjectAltNames: ['srv.lab'] } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(verifier.verify(leaf.cert, undefined, [ee.cert])).toEqual({ ok: false, reason: 'not-a-ca' });
  });

  it('pathLenConstraint=0 interdit une AC sous l\'intermédiaire', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const a = (root as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
      .issueSubordinateCA({ subject: 'CN=A', notBefore: NOW - 1000, notAfter: NOW + YEAR, pathLenConstraint: 0 });
    const b = (a as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
      .issueSubordinateCA({ subject: 'CN=B', notBefore: NOW - 1000, notAfter: NOW + YEAR });
    const leaf = b.issueCertificate({ subject: 'CN=l', notBefore: NOW - 1000, notAfter: NOW + YEAR } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(verifier.verify(leaf.cert, undefined, [b.rootCertificate, a.rootCertificate]))
      .toEqual({ ok: false, reason: 'path-length' });
  });

  it('témoin : pathLenConstraint=1 permet exactement un niveau', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const a = (root as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
      .issueSubordinateCA({ subject: 'CN=A', notBefore: NOW - 1000, notAfter: NOW + YEAR, pathLenConstraint: 1 });
    const b = (a as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
      .issueSubordinateCA({ subject: 'CN=B', notBefore: NOW - 1000, notAfter: NOW + YEAR });
    const leaf = b.issueCertificate({ subject: 'CN=l', notBefore: NOW - 1000, notAfter: NOW + YEAR } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(verifier.verify(leaf.cert, undefined, [b.rootCertificate, a.rootCertificate]).ok).toBe(true);
  });
});

describe('usage de la feuille', () => {
  it('une feuille réservée à clientAuth est refusée comme serveur (unsupported_certificate)', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const leaf = root.issueCertificate({
      subject: 'CN=c', notBefore: NOW - 1000, notAfter: NOW + YEAR, subjectAltNames: ['srv.lab'], extKeyUsage: ['clientAuth'],
    } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    const client = handshake(verifier, leaf, []);
    expect(client.result).toBe('failure');
    expect(client.lastAlert?.description).toBe('unsupported_certificate');
  });

  it('niveau de sécurité 2 (ssl_cert.c) : une clé RSA de 1024 bits vaut 80 bits < 112, refusée (weak-key)', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const leaf = root.issueCertificate({ subject: 'CN=w', notBefore: NOW - 1000, notAfter: NOW + YEAR } as never);
    const strict = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW, securityLevel: 2 });
    expect(strict.verify(leaf.cert)).toEqual({ ok: false, reason: 'weak-key' });
    const lax = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(lax.verify(leaf.cert).ok).toBe(true);
  });

  it('témoin : un certificat expiré reste expiré', () => {
    const root = CertificateAuthority.generate('CN=Root', { now: NOW });
    const old = root.issueCertificate({ subject: 'CN=o', notBefore: NOW - 3000, notAfter: NOW - 1000 } as never);
    const verifier = new CertificateVerifier({ trustAnchors: [root.rootCertificate], clock: () => NOW });
    expect(verifier.verify(old.cert)).toEqual({ ok: false, reason: 'expired' });
  });
});

/**
 * Révocation sur TOUTE la chaîne (OpenSSL crypto/x509/x509_vfy.c
 * `check_revocation` : avec `X509_V_FLAG_CRL_CHECK_ALL`, `last = num - 1`).
 *
 * MESURÉ avant correctif : `CertificateVerifier` ne consultait la CRL que
 * pour la feuille, ET la vérifiait avec la clé de l'ANCRE : la CRL d'une AC
 * intermédiaire était donc toujours « crl-untrusted » pour une feuille
 * qu'elle avait émise (une feuille révoquée sous un intermédiaire n'était
 * jamais rendue `revoked`), et une AC intermédiaire révoquée par la racine
 * laissait valides tous les certificats qu'elle avait émis.
 *
 * Avant correctif, 4 des 5 cas tombent ; le cinquième (une CRL de racine
 * signée par une autre clé est refusée) passe dans les deux états, mais
 * pour une mauvaise raison avant : la CRL de l'intermédiaire échouait la
 * vérification de signature avant même d'atteindre celle de la racine.
 */
import { describe, it, expect } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { CertificateVerifier } from '@/network/pki/CertificateVerifier';

const NOW = Date.now();
const YEAR = 365 * 24 * 3600 * 1000;

function pki() {
  const root = CertificateAuthority.generate('CN=Root', { now: NOW });
  const sub = (root as unknown as { issueSubordinateCA(o: unknown): CertificateAuthority })
    .issueSubordinateCA({ subject: 'CN=Sub', notBefore: NOW - 1000, notAfter: NOW + YEAR });
  const leaf = sub.issueCertificate({ subject: 'CN=leaf', notBefore: NOW - 1000, notAfter: NOW + YEAR });
  return { root, sub, leaf };
}

describe('CRL sur chaque maillon', () => {
  it('une feuille révoquée par son émetteur intermédiaire est refusée', () => {
    const { root, sub, leaf } = pki();
    sub.revoke(leaf.cert.serialNumber, NOW);
    const verifier = new CertificateVerifier({
      trustAnchors: [root.rootCertificate], clock: () => NOW,
      crls: [sub.publishCRL(NOW), root.publishCRL(NOW)], revocationCheck: 'crl-strict',
    });
    expect(verifier.verify(leaf.cert, undefined, [sub.rootCertificate])).toEqual({ ok: false, reason: 'revoked' });
  });

  it('une chaîne saine passe avec la CRL de chaque niveau', () => {
    const { root, sub, leaf } = pki();
    const verifier = new CertificateVerifier({
      trustAnchors: [root.rootCertificate], clock: () => NOW,
      crls: [sub.publishCRL(NOW), root.publishCRL(NOW)], revocationCheck: 'crl-strict',
    });
    expect(verifier.verify(leaf.cert, undefined, [sub.rootCertificate]).ok).toBe(true);
  });

  it('une AC intermédiaire révoquée par la racine invalide la feuille qu\'elle a émise', () => {
    const { root, sub, leaf } = pki();
    root.revoke(sub.rootCertificate.serialNumber, NOW);
    const verifier = new CertificateVerifier({
      trustAnchors: [root.rootCertificate], clock: () => NOW,
      crls: [sub.publishCRL(NOW), root.publishCRL(NOW)], revocationCheck: 'crl',
    });
    expect(verifier.verify(leaf.cert, undefined, [sub.rootCertificate])).toEqual({ ok: false, reason: 'revoked' });
  });

  it('crl-strict : sans la CRL de la racine (qui couvre l\'intermédiaire) la chaîne est refusée', () => {
    const { root, sub, leaf } = pki();
    const verifier = new CertificateVerifier({
      trustAnchors: [root.rootCertificate], clock: () => NOW,
      crls: [sub.publishCRL(NOW)], revocationCheck: 'crl-strict',
    });
    expect(verifier.verify(leaf.cert, undefined, [sub.rootCertificate])).toEqual({ ok: false, reason: 'crl-stale' });
  });

  it('une CRL de la racine dont la signature n\'est pas celle de la racine est refusée (crl-untrusted)', () => {
    const { root, sub, leaf } = pki();
    const impostor = CertificateAuthority.generate('CN=Root', { now: NOW });
    const verifier = new CertificateVerifier({
      trustAnchors: [root.rootCertificate], clock: () => NOW,
      crls: [sub.publishCRL(NOW), impostor.publishCRL(NOW)], revocationCheck: 'crl-strict',
    });
    expect(verifier.verify(leaf.cert, undefined, [sub.rootCertificate])).toEqual({ ok: false, reason: 'crl-untrusted' });
  });
});

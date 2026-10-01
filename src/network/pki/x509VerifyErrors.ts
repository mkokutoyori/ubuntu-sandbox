import type { X509Certificate } from './X509Certificate';
import type { CertificateRevocationList } from './CertificateRevocationList';
import type { VerificationReason } from './CertificateVerifier';

/**
 * Le verdict d'openssl, dit avec les mots d'openssl.
 *
 * `CertificateVerifier` répond par une RAISON ; `verify` affiche un
 * NUMÉRO, et c'est ce numéro qu'un opérateur tape dans un moteur de
 * recherche. La table est ici, en un seul endroit, pour que les deux ne
 * puissent pas se contredire.
 *
 * `unknown` couvre deux situations qu'openssl distingue et que le
 * vérificateur ne distingue pas : aucune ancre ne porte le nom de
 * l'émetteur. Si le certificat est son propre émetteur, c'est un
 * auto-signé non approuvé (18) ; sinon il manque le maillon (20).
 */
export function x509VerifyError(
  raison: VerificationReason,
  cert: X509Certificate,
  listes: readonly CertificateRevocationList[],
): { n: number; texte: string } {
  switch (raison) {
    case 'expired': return { n: 10, texte: 'certificate has expired' };
    case 'not-yet-valid': return { n: 9, texte: 'certificate is not yet valid' };
    case 'bad-signature': return { n: 7, texte: 'certificate signature failure' };
    case 'revoked': return { n: 23, texte: 'certificate revoked' };
    case 'crl-untrusted': return { n: 8, texte: 'CRL signature failure' };
    case 'not-a-ca': return { n: 24, texte: 'invalid CA certificate' };
    case 'path-length': return { n: 25, texte: 'path length constraint exceeded' };
    case 'purpose': return { n: 26, texte: 'unsupported certificate purpose' };
    case 'key-usage': return { n: 32, texte: 'key usage does not include certificate signing' };
    case 'weak-key': return { n: 66, texte: 'EE certificate key too weak' };
    case 'weak-ca-key': return { n: 67, texte: 'CA certificate key too weak' };
    case 'crl-stale':
      // Le vérificateur confond deux situations qu'openssl sépare, faute
      // d'une raison distincte : aucune CRL pour cet émetteur, ou une CRL
      // périmée. La liste est ici, on peut donc trancher.
      return listes.some((l) => l.issuer === cert.issuer)
        ? { n: 12, texte: 'CRL has expired' }
        : { n: 3, texte: 'unable to get certificate CRL' };
    default:
      return cert.subject === cert.issuer
        ? { n: 18, texte: 'self signed certificate' }
        : { n: 20, texte: 'unable to get local issuer certificate' };
  }
}


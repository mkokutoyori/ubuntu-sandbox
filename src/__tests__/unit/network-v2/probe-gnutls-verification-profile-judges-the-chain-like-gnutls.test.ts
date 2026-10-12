/**
 * Sonde : un mot-cle de priorite GnuTLS porte un PROFIL de verification
 * (NORMAL, PFS, SECURE128, PERFORMANCE : LOW ; SECURE192 / SECURE256 : HIGH ;
 * SUITEB128 / SUITEB192 : leur propre profil ; LEGACY : aucun) et le client
 * l'applique a la chaine du serveur : un certificat dont la cle, la cle de son
 * emetteur ou le condense de sa signature est plus faible que le profil est
 * refuse avec l'etat GnuTLS 0x102 (INVALID | INSECURE_ALGORITHM), ce que
 * libldap rapporte « TLS: peer cert untrusted or revoked (0x102) ». Un
 * modificateur %PROFILE_xxx remplace le profil, %VERIFY_ALLOW_* releve
 * l'interdit de SHA-1 / MD5 ; %PROFILE_SUITEB192 active en realite SUITEB128.
 *
 * Autorite : le vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) lance contre
 * `openssl s_server` avec 44 certificats reels (RSA 1024 a 4096, P-256 / P-384 /
 * P-521, SHA-1 a SHA-512 ; 16 auto-signes servant d'ancre, 28 emis par six AC
 * dont des couples cle faible / cle forte) et chacun des 11 profils (LEGACY,
 * NORMAL, 9 modificateurs %PROFILE_) : 484 resultats consignes dans
 * `gnutls-verification-profile-corpus.json`. Source lue : `verify.c`
 * (`is_level_acceptable`, `check_ca_sanity`, `_gnutls_verify_crt_status`),
 * `sign.c` (`_gnutls_sign_get_hash_strength`) et `priority.c`
 * (`check_level`, `ENABLE_PROFILE`, `enable_profile_suiteb192`) de GnuTLS
 * 3.8.3 ; les echelles (cle RSA / courbe -> niveau, bits symetriques) sont lues
 * par `gnutls_pk_bits_to_sec_param` et `gnutls_sec_param_to_symmetric_bits`.
 *
 * Constats qui ont forge le code : une ancre n'est jugee que sur la taille de
 * sa cle (pas sur son condense), un certificat emis l'est aussi sur le condense
 * de sa signature (128 bits pour SHA-256, 192 pour SHA-384) et sur la cle de
 * son emetteur ; un profil SUITEB refuse toute ancre jugee seule (l'emetteur
 * y est absent) ; SHA-1 est refuse sur tout certificat emis meme sans profil ;
 * les certificats auto-signes echappent a cette derniere regle.
 *
 * Mesure avant la modification : les 6 cas du module tombent (module neuf) ;
 * dans la sonde du controleur de domaine, 5 refus de profil sur 22 cas.
 * Passent des deux cotes : les cas ou le profil est LOW ou plus faible.
 *
 * Non attestable : l'etat GnuTLS combine un refus de profil et un autre defaut
 * (signataire inconnu, expire) n'a pas ete mesure, il est calcule par OU des
 * deux comme `_gnutls_verify_crt_status` ; le temps des ancres
 * (`check_time_status`) n'est pas rejoue ici.
 */
import { describe, expect, it } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import { parseGnutlsPriority } from '@/network/tls/gnutls/GnutlsPriority';
import {
  judgeAlgorithms, profiledCertificate, securityLevelOfKey, type ProfiledCertificate,
} from '@/network/tls/gnutls/gnutlsVerificationProfile';
import { loadJson } from './openldap-replay-support';

interface ProfileCorpus {
  readonly certificates: Readonly<Record<string, ProfiledCertificate>>;
  readonly cases: readonly { readonly priority: string; readonly chain: readonly string[]; readonly trusted: readonly string[]; readonly status: number }[];
}

const corpus = loadJson<ProfileCorpus>('gnutls-verification-profile-corpus.json');
const NOW = Date.parse('2026-02-01T00:00:00Z');
const INSECURE = 0x102;

function settingsOf(priority: string) {
  const parsed = parseGnutlsPriority(priority);
  if (parsed.ok === false) throw new Error(`priority ${priority} refused`);
  return parsed.priority.verification;
}

describe('the verification profile of a priority string judges the chain like GnuTLS', () => {
  it('the corpus is sound: it holds accepted and refused chains, self-signed and issued', () => {
    const statuses = new Set(corpus.cases.map((entry) => entry.status));
    expect(statuses).toEqual(new Set([0, INSECURE]));
    expect(corpus.cases.some((entry) => entry.chain[0] === entry.trusted[0])).toBe(true);
    expect(corpus.cases.some((entry) => entry.chain[0] !== entry.trusted[0])).toBe(true);
    expect(corpus.cases.length).toBeGreaterThan(400);
  });

  it('every chain of the corpus gets the status of the real client under every profile', () => {
    const problems: string[] = [];
    for (const entry of corpus.cases) {
      const judgement = judgeAlgorithms(
        settingsOf(entry.priority), entry.chain.map((id) => corpus.certificates[id]), entry.trusted.map((id) => corpus.certificates[id]),
      );
      if (judgement.status !== entry.status) {
        problems.push(`${entry.priority} ${entry.chain.join('+')} under ${entry.trusted.join('+')}: expected 0x${entry.status.toString(16)} got 0x${judgement.status.toString(16)}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('keywords carry their profile, the smallest wins, a %PROFILE_ modifier overrides', () => {
    expect(settingsOf('NORMAL').profile).toBe('LOW');
    expect(settingsOf('LEGACY').profile).toBeNull();
    expect(settingsOf('SECURE128').profile).toBe('LOW');
    expect(settingsOf('SECURE192').profile).toBe('HIGH');
    expect(settingsOf('SECURE256:+NORMAL').profile).toBe('LOW');
    expect(settingsOf('SUITEB128:-VERS-TLS1.3').profile).toBe('SUITEB128');
    expect(settingsOf('NORMAL:%PROFILE_ULTRA').profile).toBe('ULTRA');
    expect(settingsOf('NORMAL:%PROFILE_ULTRA:%PROFILE_MEDIUM').profile).toBe('MEDIUM');
    expect(settingsOf('NORMAL:%PROFILE_SUITEB192').profile).toBe('SUITEB128');
    expect(settingsOf('NONE:+VERS-TLS1.2:+AES-128-GCM:+AEAD:+RSA:+SIGN-ALL').profile).toBeNull();
  });

  it('the security level of a key follows gnutls_pk_bits_to_sec_param', () => {
    expect([512, 767, 1008, 1024, 1776, 2048, 3072, 8192, 15360].map((bits) => securityLevelOfKey('rsa', bits)))
      .toEqual([10, 15, 20, 25, 30, 35, 40, 45, 50]);
    expect([160, 192, 224, 256, 384, 521].map((bits) => securityLevelOfKey('ec', bits))).toEqual([25, 30, 35, 40, 45, 50]);
  });

  it('the descriptor of a simulated certificate carries its real key size and signature', () => {
    for (const bits of [1024, 2048, 3072]) {
      const authority = CertificateAuthority.generate('CN=Lab Root CA', { now: NOW, keyBits: bits });
      const described = profiledCertificate(authority.rootCertificate);
      expect(described).toMatchObject({ keyKind: 'rsa', keyBits: bits, signatureKind: 'rsa', signatureHash: 'sha256', version: 3 });
    }
    const elliptic = profiledCertificate(CertificateAuthority.generate('CN=EC CA', { now: NOW, algorithm: 'ecdsa' }).rootCertificate);
    expect(elliptic).toMatchObject({ keyKind: 'ec', keyBits: 256, curve: 'secp256r1', signatureKind: 'ecdsa', signatureHash: 'sha256' });
  }, 120000);

  it('a simulated issued certificate is judged against its issuer', () => {
    const weakIssuer = CertificateAuthority.generate('CN=Weak CA', { now: NOW, keyBits: 2048 });
    const leaf = weakIssuer.issueCertificate({ subject: 'CN=host', notBefore: NOW - 1000, notAfter: NOW + 1e9, keyBits: 3072 });
    const chain = [profiledCertificate(leaf.cert)];
    const anchors = [profiledCertificate(weakIssuer.rootCertificate)];
    expect(judgeAlgorithms(settingsOf('NORMAL:%PROFILE_MEDIUM'), chain, anchors).status).toBe(0);
    expect(judgeAlgorithms(settingsOf('NORMAL:%PROFILE_HIGH'), chain, anchors).status).toBe(INSECURE);
  }, 120000);
});

/**
 * Sonde : le « niveau » que la chaine de priorites GnuTLS laisse a la session
 * (chaque mot-cle en pose un, le plus bas gagne ; %PROFILE_xxx le remplace) fixe
 * la taille minimale du nombre premier Diffie-Hellman qu'un serveur peut envoyer :
 * un premier trop court fait echouer la poignee de main avec « The Diffie-Hellman
 * prime sent by the server is not acceptable (not long enough). » (-63).
 *
 * Autorite : le vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) contre `openssl s_server
 * -dhparam <fichier> -cipher DHE-RSA-AES128-GCM-SHA256 -no_tls1_3` avec des groupes
 * de 1024 (premier sur), 1536 (modp_1536), 2048 (modp_2048), 3072 et 4096 (ffdhe)
 * bits, sous dix-huit chaines (NORMAL, LEGACY, PERFORMANCE, SECURE128, PFS, NORMAL
 * suivi de chacun des 9 %PROFILE_xxx, LEGACY puis %PROFILE_MEDIUM, et trois
 * chaines NONE:... / modificateur avant mot-cle), soit 78 couples consignes dans
 * `gnutls-dh-level-corpus.json`. Source lue : `check_level` / `SET_LEVEL` /
 * `ENABLE_PROFILE` de priority.c, `_gnutls_proc_dh_common_server_kx` de
 * dh_common.c ; la table niveau -> bits est celle de
 * `gnutls_sec_param_to_pk_bits(GNUTLS_PK_DH, niveau)`.
 *
 * Constats : NORMAL / PFS / PERFORMANCE (WEAK, 1008) et SECURE128 (LOW, 1024)
 * acceptent 1024 ; LEGACY comme mot-cle (VERY_WEAK) accepte tout ; MEDIUM exige
 * 2048, HIGH 3072 ; ULTRA et FUTURE n'exigent PAS 8192 / 15360 mais 3072 (la
 * valeur de la table est plafonnee a 3072, mesure : 3072 et 4096 passent) ;
 * %PROFILE_SUITEB192 active en fait SUITEB128 donc HIGH ; une chaine NONE:...
 * sans mot-cle ne pose aucun niveau et accepte 1024 ; `%PROFILE_MEDIUM:NORMAL`
 * retombe a WEAK (le plus bas gagne).
 *
 * Mesure avant la modification : 22 des 78 couples tombent (tous les refus : la
 * pile ne connaissait que la regle des niveaux de securite d'OpenSSL, qui
 * accepte 1024 bits et refuse moins). Passent des deux cotes : les 56 acceptations.
 *
 * Non attestable : les premiers de 512 et 768 bits (OpenSSL 3 ne les charge pas) ;
 * le plafond de 3072 n'est mesure qu'en 3072 et 4096 bits.
 */
import { describe, expect, it } from 'vitest';
import { CertificateAuthority } from '@/network/pki/CertificateAuthority';
import type { TlsServerConfig } from '@/network/tls/TlsServerSession';
import { connectWithPriority } from './gnutls-handshake-support';
import { loadJson } from './openldap-replay-support';

interface DhCase {
  readonly priority: string;
  readonly bits: number;
  readonly accepted: boolean;
}

const corpus = loadJson<readonly DhCase[]>('gnutls-dh-level-corpus.json');
const NOW = Date.parse('2026-02-01T00:00:00Z');
const GROUP_OF_BITS: Readonly<Record<number, number>> = { 1024: 2, 1536: 5, 2048: 14, 3072: 15, 4096: 16 };
const DH_PRIME_REFUSED = "TLS: can't connect: The Diffie-Hellman prime sent by the server is not acceptable (not long enough)..";

let issued: ReturnType<CertificateAuthority['issueCertificate']> | null = null;

function serverWithPrimeOf(bits: number): TlsServerConfig {
  if (issued === null) {
    const authority = CertificateAuthority.generate('CN=Lab Root CA', { now: NOW });
    issued = authority.issueCertificate({ subject: 'CN=vm', notBefore: NOW - 1000, notAfter: NOW + 1e9 });
  }
  const leaf = issued;
  return {
    serverCert: leaf.cert, serverPrivateKey: leaf.privateKey, protocols: ['1.2'], preferServerCiphers: false,
    cipherList: 'DHE-RSA-AES128-GCM-SHA256:@SECLEVEL=0', securityLevel: 0, dhGroupId: GROUP_OF_BITS[bits],
  };
}

describe('the level of a priority string decides the Diffie-Hellman prime like the real client', () => {
  it('the corpus is sound: it holds acceptances and refusals for every prime size', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(78);
    for (const bits of Object.keys(GROUP_OF_BITS)) {
      expect(corpus.some((entry) => entry.bits === Number(bits) && entry.accepted)).toBe(true);
    }
    expect(corpus.some((entry) => !entry.accepted)).toBe(true);
  });

  it('every pair of the corpus ends as with the real client', async () => {
    const problems: string[] = [];
    for (const entry of corpus) {
      const outcome = await connectWithPriority(entry.priority, () => serverWithPrimeOf(entry.bits));
      const refused = outcome.lines.includes(DH_PRIME_REFUSED);
      const established = outcome.suite !== null;
      if (entry.accepted !== established || entry.accepted === refused) {
        problems.push(`${entry.priority} with ${entry.bits} bits: expected ${entry.accepted ? 'success' : 'DH refusal'}, got ${outcome.lines.join('|') || outcome.suite}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  }, 120000);
});

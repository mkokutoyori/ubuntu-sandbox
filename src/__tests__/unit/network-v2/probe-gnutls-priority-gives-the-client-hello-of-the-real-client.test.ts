/**
 * Sonde : ce qu'une chaine de priorites GnuTLS met dans le ClientHello est
 * ce que le vrai `ldapsearch` envoie : suites (ordre de `set_ciphersuite_list`,
 * sans les suites PSK / anonymes faute d'identifiants, TLS 1.3 seulement si la
 * version est active), versions (`supported_versions` absente sans TLS 1.3),
 * groupes (courbes puis corps finis dans l'ordre du premier echange de cles
 * rencontre, completes par le balayage TLS 1.3), parts de cle (le premier
 * groupe puis le premier d'une autre famille : SECP, X25519, X448, FFDHE),
 * algorithmes de signature (un doublon de code n'est retire que s'il est
 * voisin), et rien du tout avec %NO_EXTENSIONS.
 *
 * Autorite : 700 ClientHello captures sur un port TCP d'ecoute, emis par le
 * vrai `ldapsearch` 2.6.10 (GnuTLS 3.8.3) lance avec `LDAPTLS_CIPHER_SUITE` =
 * chaine tiree au hasard parmi les chaines acceptees du corpus de la sonde
 * voisine ; l'enregistrement TLS est decode octet a octet (suites, extensions
 * 43 / 10 / 51 / 13).
 *
 * Constats : sans filtre sur les echanges de cles a identifiants, le modele
 * annoncait 47 suites de trop ; avec TLS 1.3 et DTLS 1.2 actifs et TLS 1.2
 * retire, le vrai client propose quand meme les suites TLS 1.2 (leur borne est
 * l'age le plus bas de TOUTES les versions) ; l'ordre des groupes n'est pas
 * celui de la liste brute mais celui du premier echange de cles ; deux codes
 * de signature identiques ne sont fusionnes que cote a cote.
 *
 * Mesure avant la modification : les 700 cas tombent (module neuf). Passent des
 * deux cotes : aucun.
 *
 * Non attestable : TLS_FALLBACK_SCSV (%FALLBACK_SCSV ajoute la suite 0x5600 ;
 * la pile TLS simulee n'a pas de repli de version a detecter).
 */
import { describe, expect, it } from 'vitest';
import { parseGnutlsPriority } from '@/network/tls/gnutls/GnutlsPriority';
import { clientHelloOffer } from '@/network/tls/gnutls/gnutlsClientOffer';
import { loadJson } from './openldap-replay-support';

interface HelloCorpus {
  readonly lists: readonly (readonly (string | number)[])[];
  readonly cases: readonly (readonly [string, number, number, number, number, number])[];
}

const corpus = loadJson<HelloCorpus>('gnutls-client-hello-corpus.json');

function hex(codes: readonly number[]): string[] {
  return codes.map((code) => code.toString(16).padStart(4, '0'));
}

describe('a priority string gives the ClientHello of the real client', () => {
  it('the corpus is sound: it covers TLS 1.3, TLS 1.2 only and extension-less hellos', () => {
    expect(corpus.cases.length).toBeGreaterThanOrEqual(700);
    const versions = corpus.cases.map((entry) => corpus.lists[entry[2]]);
    expect(versions.some((entry) => entry.length === 0)).toBe(true);
    expect(versions.some((entry) => entry.includes('0304'))).toBe(true);
    expect(corpus.cases.some((entry) => corpus.lists[entry[3]].length === 0 && corpus.lists[entry[1]].length > 0)).toBe(true);
  });

  it('every captured ClientHello is reproduced for suites, versions, groups, key shares and signatures', () => {
    const problems: string[] = [];
    for (const [priority, suites, versions, groups, shares, signatures] of corpus.cases) {
      const parsed = parseGnutlsPriority(priority);
      if (parsed.ok === false) {
        problems.push(`${JSON.stringify(priority)}: refused`);
        continue;
      }
      const offer = clientHelloOffer(parsed.priority);
      const checks: [string, readonly (string | number)[], readonly (string | number)[]][] = [
        ['suites', corpus.lists[suites], hex(offer.suiteCodes)],
        ['versions', corpus.lists[versions], hex(offer.supportedVersions)],
        ['groups', corpus.lists[groups], offer.groupCodes],
        ['key shares', corpus.lists[shares], offer.keyShareCodes],
        ['signatures', corpus.lists[signatures], hex(offer.signatureCodes)],
      ];
      for (const [name, expected, actual] of checks) {
        if (expected.join(',') !== actual.join(',')) problems.push(`${JSON.stringify(priority)}: ${name} expected ${expected.join(',')} got ${actual.join(',')}`);
      }
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });
});

/**
 * Sonde : une chaine de priorites GnuTLS (`TLS_CIPHER_SUITE`, `gnutls-cli
 * --priority`) se lit comme `gnutls_priority_init` : mots-cles (NORMAL, PFS,
 * SECURE128/192, SUITEB128/192, LEGACY, PERFORMANCE), `+`/`-`/`!` sur les noms
 * et les groupes `X-ALL`, modificateurs `%`, remplacement du premier mot-cle
 * puis ajout, `-X-ALL` qui vide la liste, position de l'erreur de syntaxe,
 * defauts de `NONE`, et passage de `set_ciphersuite_list` (TLS 1.3 retire sans
 * groupe, sans signature utilisable ou avec NULL / RSA-PSK / %NO_EXTENSIONS).
 *
 * Autorite : `gnutls-cli --priority <chaine> --list` (GnuTLS 3.8.3, politique
 * Ubuntu : TLS 1.0 / 1.1 / DTLS 1.0 / 0.9 desactives) sur 5502 chaines
 * distinctes, dont 1300 tirees au hasard avec le vocabulaire complet
 * (chiffrements, MAC, echanges de cles, groupes, courbes, signatures,
 * versions, GOST, types de certificat) ; les listes Protocols / Ciphers /
 * MACs / Key Exchange / Groups / PK-signatures et les suites imprimees sont
 * comparees une a une. Source lue : `priority.c` de GnuTLS 3.8.3
 * (`check_level`, `gnutls_priority_init`, `set_ciphersuite_list`,
 * `break_list`, `_gnutls_resolve_priorities`). La table des suites vient de
 * `gnutls_cipher_suite_info`, celle des signatures par version de 46 noms x 3 versions de sondes
 * `--list`, le vocabulaire de `gnutls_*_list`.
 *
 * Constats qui ont forge le code : un prefixe suffit (`+GOSTxxx` declenche le
 * paquet GOST, `+VERS-ALLxxx` vaut `+VERS-ALL`, `+MAC-xxx` inconnu est
 * ignore) ; `-GOST` et `-SIGN-GOST-ALL` vident les listes entieres ;
 * `GOST28147-CPXCOM-CFB` n'est pas un nom de chiffrement mais le paquet GOST ;
 * le groupe `GC256A` n'existe pas comme groupe (seuls GC256B et GC512A
 * comptent pour garder TLS 1.3) ; 128 elements au plus sont lus ; une espace
 * en tete decale la position d'erreur a zero ; apres un « : » seules les
 * espaces (pas les tabulations) sont sautees.
 *
 * Mesure avant la modification : les 5502 cas tombent (le module n'existait
 * pas : le fichier ne se charge pas). Aucun cas ne passe des deux cotes.
 *
 * Non attestable : les chaines `@MOT` (la table /etc/gnutls/config du poste de
 * mesure n'a pas de section `priorities`, donc elles echouent comme ici).
 */
import { describe, expect, it } from 'vitest';
import { parseGnutlsPriority } from '@/network/tls/gnutls/GnutlsPriority';
import { loadJson } from './openldap-replay-support';

interface PriorityCorpus {
  readonly lists: readonly (readonly string[])[];
  readonly cases: readonly (readonly [string, string | null, ...number[]])[];
}

const corpus = loadJson<PriorityCorpus>('gnutls-priority-corpus.json');

function listed(values: readonly string[]): string {
  return values.length === 0 ? 'none' : values.join(',');
}

function failureLine(parsed: ReturnType<typeof parseGnutlsPriority>): string {
  if (parsed.ok !== false) return 'ok';
  return parsed.kind === 'syntax' ? `Syntax error at: ${parsed.at}` : 'Error in priorities: No or insufficient priorities were set.';
}

describe('priority strings are read like gnutls_priority_init', () => {
  it('the corpus is sound: it holds accepted and refused strings of every kind', () => {
    const refused = corpus.cases.filter((entry) => entry[1] !== null);
    expect(corpus.cases.length).toBeGreaterThan(5000);
    expect(refused.some((entry) => String(entry[1]).startsWith('Syntax error'))).toBe(true);
    expect(refused.some((entry) => String(entry[1]).startsWith('Error in priorities'))).toBe(true);
    expect(corpus.cases.length - refused.length).toBeGreaterThan(2000);
  });

  it('every string is accepted or refused as gnutls-cli does, with the same lists and suites', () => {
    const problems: string[] = [];
    for (const [priority, error, ...rest] of corpus.cases) {
      const parsed = parseGnutlsPriority(priority);
      if (error !== null) {
        if (failureLine(parsed) !== error) problems.push(`${JSON.stringify(priority)}: expected [${error}] got [${failureLine(parsed)}]`);
        continue;
      }
      if (parsed.ok === false) {
        problems.push(`${JSON.stringify(priority)}: expected acceptance, got ${parsed.kind}`);
        continue;
      }
      const expected = rest.map((index) => corpus.lists[index]);
      const got = parsed.priority;
      const actual = [got.protocols, got.ciphers, got.macs, got.kx, got.groups, got.signatures];
      const names = ['protocols', 'ciphers', 'macs', 'kx', 'groups', 'signatures'];
      for (let i = 0; i < names.length; i++) {
        if (listed(expected[i]) !== listed(actual[i])) problems.push(`${JSON.stringify(priority)}: ${names[i]} expected ${listed(expected[i])} got ${listed(actual[i])}`);
      }
      const codes = got.suites.map((suite) => suite.code);
      if (codes.join(',') !== expected[6].join(',')) problems.push(`${JSON.stringify(priority)}: suites expected ${expected[6].join(',')} got ${codes.join(',')}`);
    }
    expect(problems.slice(0, 10)).toEqual([]);
  });

  it('a keyword replaces the defaults before the first one and adds after it', () => {
    const replaced = parseGnutlsPriority('SECURE192:+NORMAL');
    const only = parseGnutlsPriority('SECURE192');
    expect(replaced.ok && only.ok).toBe(true);
    if (replaced.ok && only.ok) {
      expect(only.priority.ciphers).toEqual(['AES-256-GCM', 'CHACHA20-POLY1305', 'AES-256-CBC', 'AES-256-CCM']);
      expect(replaced.priority.ciphers).toContain('AES-128-GCM');
    }
  });

  it('a negated bulk group empties the list and is rebuilt by what follows', () => {
    const rebuilt = parseGnutlsPriority('NORMAL:-CIPHER-ALL:+AES-128-GCM');
    expect(rebuilt.ok && rebuilt.priority.ciphers).toEqual(['AES-128-GCM']);
    expect(parseGnutlsPriority('NORMAL:-CIPHER-ALL')).toEqual({ ok: false, kind: 'insufficient' });
  });
});

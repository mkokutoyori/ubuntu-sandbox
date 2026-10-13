/*
 * Sonde des formats de fichier de nano (DOS / Mac, -u, -N) et des modes d'ecriture de Write Out (M-D, M-M, M-A,
 * M-P, M-B, -B, -C), un laboratoire minimal par regle, enregistres sur nano 7.2 (scripts/oracle/record_nano_screen.py
 * --corpus cli --from, avec `disk: true`, `raw` pour poser des octets exacts et `hidden: true`) : rangees du pane,
 * cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : le premier saut de ligne decide du format (CRLF : DOS) et « Converted from DOS format »
 * s'ajoute au message de lecture ; le format n'apparait pas dans le titre mais dans l'invite « File Name to Write
 * [DOS Format]: » (le tag Backup vient apres) ; un tampon DOS est reecrit en CRLF, `-u` l'enregistre en Unix, `-N`
 * garde les CR comme du texte ; M-A et M-P changent l'invite (« Append to File », « Prepend to File », « Append
 * Selection to File »), vident le nom et ajoutent ou inserent devant le fichier cible ; M-B (ou `-B`) garde la version
 * precedente dans `t.txt~` (ou `-C dir/` sous `dir/<chemin avec ! pour />~`), sans sauvegarde pour un fichier neuf.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 28 des 30 tests tombent sur le moteur
 * d'avant, 0 apres ; passent dans les deux cas le test de chargement (structurel) et `fmt-noconvert` (temoin : sans
 * conversion le moteur d'avant gardait deja les CR comme du texte).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-format/format-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano file formats and Write Out modes, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(29);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

/*
 * Sonde de la ligne de commande de nano, un laboratoire minimal par regle, enregistres sur nano 7.2 (scripts/
 * oracle/record_nano_screen.py --corpus cli --from) : sortie standard, erreur standard, code de sortie, ou
 * premier ecran et cellule du curseur quand l'editeur s'ouvre.  Les corpus aleatoires de nano-cli-oracle.test.ts
 * couvrent le meme terrain a l'echelle ; ici chaque cas nomme la regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` (le code du commit precedent) : le
 * fichier ne se charge pas, NanoCommandLine n'existe pas, donc les 55 tests tombent a l'import.  Mesure de fond
 * avec l'ancien analyseur (parseEditorArgs, qui ne lisait que -v -c -l -S, +L,C et quatre mots d'impression)
 * et l'ancien moteur dans un test jetable : 46 des 54 laboratoires donnaient une autre issue que nano
 * (imprimer ou refuser au lieu d'ouvrir et inversement, curseur laisse en haut, recherche ignoree, message
 * absent), 8 passaient deja et passent encore : cli-witness (le lab lit l'ecran correctement),
 * cli-permutation, cli-attached-argument, cli-long-equals, cli-fill-negative, cli-plus-line,
 * cli-plus-line-column et cli-plus-beyond (l'ancien analyseur ignorait les options qu'il ne connaissait pas et
 * ces cas n'ont pas d'effet sur le premier ecran).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-cli/cli-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano command line, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(54);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

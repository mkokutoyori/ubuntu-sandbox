/*
 * Sonde des options d'edition de nano, un laboratoire minimal par regle, enregistres sur nano 7.2 (scripts/oracle/
 * record_nano_screen.py --corpus cli --from, avec `disk: true`) : rangees du pane, cellule du curseur et fichiers du
 * repertoire apres chaque etape.  Les corpus aleatoires de nano-edit-oracle.test.ts couvrent le meme terrain a
 * l'echelle ; ici chaque cas nomme la regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : au premier increment 36 des 49 tests
 * tombaient sur le moteur d'avant, 0 apres ; au suivant (les 10 laboratoires `edit-toggle-*` : M-i M-o M-h M-k M-l,
 * mesures sur le moteur de la justification) 10 des 59 tombent avant, 0 apres.  Passent avant comme apres : le test de chargement (structurel), edit-witness (le lab lit
 * correctement rangees et disque), et onze laboratoires dont le comportement par defaut etait deja juste et que
 * l'on garde comme temoins de non-regression : edit-smarthome-off, edit-cut-line, edit-cut-appends,
 * edit-copy-then-cut, edit-nonewlines (le discriminant de -L est le corpus), edit-newlines-default,
 * edit-afterends-off, edit-wordbounds-off, edit-wordchars-off, edit-scroll-down et edit-cut-viewport.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-edit/edit-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano editing options, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(58);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

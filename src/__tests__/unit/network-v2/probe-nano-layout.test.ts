/*
 * Sonde de la mise en page de nano, un laboratoire minimal par regle, enregistres sur nano 7.2 (scripts/oracle/
 * record_nano_screen.py --corpus cli --from) : rangees du pane et cellule du curseur apres chaque etape.  Les
 * corpus aleatoires de nano-layout-oracle.test.ts couvrent le meme terrain a l'echelle ; ici chaque cas nomme la
 * regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : au premier increment (sans `-_`) 18 des 23
 * tests tombaient sur le moteur d'avant, 0 apres ; au second (les 12 laboratoires `lay-minibar-*`, mesures sur le
 * moteur du premier) 12 des 35 tombent avant, 0 apres ; au troisieme (les 7 laboratoires `lay-zero-*` et
 * `lay-mark-keeps-column`, mesures sur le moteur du second) 8 des 43 tombent avant, 0 apres.  Les tests qui
 * passent avant comme apres sont nommes :
 * le test de chargement (structurel), lay-witness (le lab lit l'ecran correctement), lay-emptyline-too-short,
 * lay-bars-at-six-rows et lay-stateflags-view (aucune option n'y change l'ecran : `-e` a 6 lignes, barres a 6
 * lignes, `View` prime sur `-%`).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-layout/layout-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano layout, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(42);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

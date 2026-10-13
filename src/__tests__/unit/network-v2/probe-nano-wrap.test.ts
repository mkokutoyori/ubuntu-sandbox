/*
 * Sonde de la justification et de la coupure de ligne de nano, un laboratoire minimal par regle, enregistres sur
 * nano 7.2 (scripts/oracle/record_nano_screen.py --corpus cli --from, avec `disk: true`) : rangees du pane, cellule
 * du curseur et fichiers du repertoire apres chaque etape.  Les corpus aleatoires de nano-wrap-oracle.test.ts
 * couvrent le meme terrain a l'echelle ; ici chaque cas nomme la regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 24 des 33 tests tombent sur le moteur
 * d'avant, 0 apres.  Passent avant comme apres : le test de chargement (structurel), wrap-witness (le lab lit
 * correctement rangees et disque) et sept laboratoires dont le comportement par defaut etait deja juste, gardes
 * comme temoins de non-regression : wrap-justify-message, wrap-justify-squeeze, wrap-justify-no-bookstyle,
 * wrap-justify-view, wrap-hard-off, wrap-hard-paste et wrap-softwrap.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-wrap/wrap-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano justification and hard wrapping, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(32);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

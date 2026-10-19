/**
 * Sonde de ^S (Enregistrer) de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus search --from, avec `disk: true` et `hidden: true`) : rangees du pane,
 * cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : ^S ecrit le tampon sous son propre nom sans rien demander (« Wrote N lines »), meme intact, meme
 * avec une marque (le fichier entier, pas la selection), sous -R, -t, -N, -B (la sauvegarde `t.txt~`), -L et en tant que root sur
 * un fichier en lecture seule ; un tampon sans nom ouvre l'invite Write Out ; en mode lecture seule elle est refusee ; sous -p
 * (^S est avalee) et dans une invite elle ne fait rien ; la minibarre montre « (N lines) », l'interface cachee rien ; une
 * annulation apres l'enregistrement remet le tampon a Modified.
 *
 * Mesure avec `git stash push -- NanoEngine.ts` (le moteur seul, ^S ne faisait rien) : 18 des 20 laboratoires tombaient avant,
 * 0 apres.  Passent dans les deux cas s10 (^S avalee sous -p) et s19 (^S dans une invite) : temoins de non-regression.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-save/save-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano ^S Save, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(20);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

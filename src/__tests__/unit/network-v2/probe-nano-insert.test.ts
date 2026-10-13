/*
 * Sonde de ^R Read File et du collage ^U de nano, un laboratoire minimal par regle, enregistres sur nano 7.2
 * (scripts/oracle/record_nano_screen.py --corpus cli --from, avec `disk: true`, `files` et `raw` pour poser des
 * octets exacts) : rangees du pane, cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : l'invite dit « File to insert [from ./]: » (« File to insert unconverted [from ./]: »
 * avec -N ou apres M-N, bascule qui survit a l'invite) ; un fichier qui finit par un saut de ligne arrive devant la
 * ligne courante (le saut final la separe du reste), une derniere ligne sans saut de ligne se soude au reste ; le
 * curseur va a la fin du texte insere et le tampon n'est « Modified » que si le curseur a bouge (un fichier vide
 * n'insere rien : « Read 0 lines ») ; un nom vide annule ; un fichier absent repond `File "x" not found`, un dossier
 * `"x" is a directory` ; DOS et Mac sont convertis avec « (Converted from DOS format) » sauf avec -N / M-N.
 * Une insertion ou un collage de moins d'un ecran garde la fenetre (le curseur descend au plus bas), au-dela le curseur
 * est recentre : le moteur recentrait aussi les collages courts et ne recentrait jamais les longs.
 *
 * Mesure avec `git stash push -- src/network src/components src/terminal` : 34 des 43 tests tombent sur le moteur
 * d'avant, 0 apres ; passent dans les deux cas le test de chargement (structurel), ins-label, ins-cancel et
 * ins-cancel-key (invite et annulation deja justes) et paste-small, paste-exact, paste-small-softwrap,
 * paste-big-softwrap et paste-big-tall (collages qui tiennent dans la fenetre : le moteur les faisait deja suivre).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const read = (name: string): Lab[] => (JSON.parse(readFileSync(`src/__tests__/support/oracle/nano-insert/${name}`, 'utf8')) as { cases: Lab[] }).cases;
const labs = [...read('insert-labs.json'), ...read('paste-labs.json')];

describe('nano Read File and Paste, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(39);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

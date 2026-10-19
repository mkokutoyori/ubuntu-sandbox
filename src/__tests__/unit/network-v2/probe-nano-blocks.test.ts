/**
 * Sonde des deplacements par paragraphe et par bloc, de l'invite Go To Line et de l'astuce de ^H, un laboratoire minimal
 * par regle, enregistres sur nano 7.2 (scripts/oracle/record_nano_screen.py --corpus search --from, avec `disk: true` et
 * `hidden: true`) : rangees du pane, cellule du curseur et fichiers du repertoire apres chaque etape.
 *
 * Ce que le binaire a montre : voir l'en-tete de nano-blocks-oracle.test.ts pour la liste ; ici chaque regle a son
 * laboratoire : g01 a g16 (^Y ^V ^W ^O ^T dans l'invite, M-G), n01 a n14 (M-( M-) M-9 M-0 M-7 M-8 ^Haut ^Bas, M-{ M-}
 * muets), view-* et view2-* (la fenetre se recentre sur une ligne donnee, jamais sur une colonne seule), hint-*, hint3-*
 * et hint4-* (^H au debut du tampon : l'astuce, ses exceptions -x -v marque et touche Alt), zero-* (-0 : les sorties
 * d'invite qui redessinent la rangee couverte).
 *
 * Mesure avec `git stash push -- NanoEngine.ts nano/NanoText.ts` (le moteur seul) : 59 des 119 laboratoires tombaient avant,
 * 0 apres.  Passent dans les deux cas 60 laboratoires qui servent de temoins ou de non-regression : l'invite simple
 * (g08), les barres sous -R (g16), M-{ et M-} muets (n11, n12), le recentrage d'un numero de ligne (view-*), ^H au milieu
 * d'une ligne ou la ou l'astuce est refusee (hint-h02, h04, h06, h08 a h12, h16, hint3-*, hint4-*) et les sorties d'invite
 * du mode -0 (zero-*).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayNanoCliCase, screenIsPorted, type NanoCliCase } from '../../support/oracle/nanoCliReplay';

interface Lab extends NanoCliCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/nano-blocks/blocks-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('nano paragraph and block motions, Go To Line and the Ctrl-H hint, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(119);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(screenIsPorted(lab.args)).toBe(true);
    expect(replayNanoCliCase(lab) ?? '').toBe('');
  });
});

/*
 * Sonde de `showmatch`, un laboratoire minimal par regle, enregistres sur vim 9.1 (tmux, une touche a la fois,
 * scripts/oracle/record_vim_screen.py --from) : lignes de la fenetre, cellule du curseur et regle apres chaque
 * etape.  Le corpus aleatoire de vim-showmatch-oracle.test.ts couvre le meme terrain a l'echelle ; ici chaque cas
 * nomme la regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components` (moteur du commit precedent, ou `showmatch` etait lu,
 * liste par `:set sm?` et ignore) : 8 des 16 tests tombent avant, 0 apres.  Les 8 qui passent avant comme apres sont
 * nommes : le test de chargement (structurel), sm-off-witness (sans `showmatch` le curseur reste apres la fermante,
 * ce qui prouve que le lab lit l'ecran correctement) et six refus ou rien ne doit bouger, que l'ancien moteur
 * respectait faute de sauter : sm-no-match, sm-opening-ignored, sm-off-screen, sm-matchtime-zero,
 * sm-matchpairs-empty et sm-nowrap-hidden.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

interface Lab extends ScreenCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/vim-showmatch/showmatch-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('showmatch, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(15);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayScreenCase(lab) ?? '').toBe('');
  });
});

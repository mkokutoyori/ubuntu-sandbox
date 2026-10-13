/*
 * Sonde de `incsearch`, un laboratoire minimal par regle, enregistres sur vim 9.1 (tmux, une touche a la fois,
 * scripts/oracle/record_vim_screen.py --from) : lignes de la fenetre, cellule du curseur, cellules IncSearch (video
 * inverse) et Search apres chaque frappe.  Le corpus aleatoire de vim-incsearch-oracle.test.ts couvre le meme terrain
 * a l'echelle ; ici chaque cas nomme la regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components` (moteur du commit precedent, ou `incsearch` etait lu,
 * liste par `:set is?` et ignore) : 14 des 17 tests tombent avant, 0 apres.  Les 3 qui passent avant comme apres
 * sont nommes : le test de chargement (structurel), is-off-witness (avec `noincsearch` la fenetre ne bouge pas, ce
 * qui prouve que le lab lit l'ecran correctement) et is-empty-hides-hlsearch (un `/` seul laisse le surlignage
 * d'avant, l'ancien moteur le laissait aussi).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

interface Lab extends ScreenCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/vim-incsearch/incsearch-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('incsearch, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(16);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayScreenCase(lab) ?? '').toBe('');
  });
});

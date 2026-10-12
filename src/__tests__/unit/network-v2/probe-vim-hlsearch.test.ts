/*
 * Sonde de `hlsearch`, un laboratoire minimal par regle, enregistres sur vim 9.1 (tmux, `vim -u DEFAULTS --noplugin
 * -i NONE -n`, scripts/oracle/record_vim_screen.py --from) : lignes de la fenetre, cellule du curseur et cellules
 * peintes avec le fond du groupe Search apres chaque etape.  Le corpus aleatoire de vim-hlsearch-oracle.test.ts
 * couvre le meme terrain a l'echelle ; ici chaque cas nomme la regle qu'il isole.
 *
 * Mesure avec `git stash push -- src/network src/components` (moteur du commit precedent, ou `hlsearch` etait lu,
 * liste par `:set hls?` et ignore a l'affichage) : 16 des 18 tests tombent avant, 0 apres.  Les 2 qui passent avant
 * comme apres sont nommes : le test de chargement (structurel) et le TEMOIN hls-off-witness (sans `hlsearch` rien
 * n'est surligne, ce qui prouve que le lab lit l'ecran correctement et que l'ancien moteur n'est pas battu par un
 * simple ecart de texte ou de curseur).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

interface Lab extends ScreenCase { why: string }

const labs = (JSON.parse(readFileSync('src/__tests__/support/oracle/vim-hlsearch/hlsearch-labs.json', 'utf8')) as { cases: Lab[] }).cases;

describe('hlsearch, one measured laboratory per rule', () => {
  it('loads the recorded laboratories', () => {
    expect(labs.length).toBe(17);
  });

  it.each(labs.map((lab) => [lab.id, lab.why, lab] as const))('%s: %s', (_id, _why, lab) => {
    expect(replayScreenCase(lab) ?? '').toBe('');
  });
});

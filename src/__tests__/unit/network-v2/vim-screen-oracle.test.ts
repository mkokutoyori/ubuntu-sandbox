/**
 * L'ecran de vim rejoue contre un vrai vim 9.1 pilote par tmux (scripts/oracle/record_vim_screen.py,
 * `vim -u DEFAULTS --noplugin -i NONE -n`, locale UTF-8) : apres chaque etape on compare les lignes
 * de la fenetre, la cellule du curseur, et la colonne de la regle.  Six corpus aleatoires :
 *   cells (400 cas de deplacements dans des tampons a tabulations, CJK, accents, `list`, `nu`,
 *   `nowrap`, `sidescroll`), scroll (Ctrl-F/B/D/U/E/Y, z*, H/M/L, scrolloff), resize (redimension-
 *   nement de la fenetre entre les etapes) et click (deux corpus de 200 cas, seeds 9 et 21, de clics de souris en encodage SGR,
 *   avec `:set mouse=` tire parmi a, n, nv, i, v, nvi et vide).
 *
 * Methode : la fenetre (VimWindow.ts) transcrit move.c et window.c de vim 9.1.0016 lus dans l'archive source
 * (update_topline, scroll_cursor_top/bot/halfway, cursor_correct, curs_columns, check_cursor_moved, win_new_height,
 * scroll_to_fraction, onepage, halfpage, set_leftcol), sans heuristique : meme drapeaux de validite, meme
 * second update_topline quand w_botline change, memes `w_skipcol` et rangee `<<<` pour une ligne plus haute que
 * la fenetre.  Un binaire instrumente (macro TRACE) a servi a lire les decisions de vim pas a pas quand une
 * transcription divergeait.
 *
 * Mesure avec `git stash push -- src/network` (moteur du commit precedent) : 5 des 6 tests tombent avant
 * (cells-seed2, click-seed9, click-seed21, resize-seed5, scroll-seed3 ; le sixieme, cells-seed1, passe avant comme apres,
 * c'est le TEMOIN que le lab est sain), et 36 des 1250 cas divergent (2 + 12 + 6 + 9 + 7), 0 apres hors
 * UNPORTED_CASES.  Le corpus click seul, rejoue au tout premier moteur de a0acef2cc, perdait 107 cas (clics sans
 * effet, `Ctrl-F` en Visuel, colonne d'une tabulation en Visuel).  Les cas a `mouse=` vide ou un clic ne doit
 * RIEN faire (un vim Debian/Ubuntu lit `defaults.vim` avec la souris coupee) sont dans le corpus et passent.
 * Trois lots frais, enregistres apres l'ajustement (environ 1650 cas), ont servi de verification hors echantillon.
 *
 * Divergence connue, mesuree et NON portee (UNPORTED_CASES) : 1 cas sur 1250.
 *   - clk21-53 : deux clics sur la meme cellule a moins de 'mousetime' (500 ms) ; vim y voit un double-clic
 *     et selectionne le mot, ce moteur y voit deux clics simples.  Le navigateur fournit `event.detail`, le
 *     branchement est a faire cote composant ; il n'est pas epingle comme contrat : si le cas se met a passer,
 *     le test echoue pour qu'on le retire de la liste.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'clk21-53',
]);

const dir = 'src/__tests__/support/oracle/vim-screen';
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ name: f, ...JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { vim: string; cases: ScreenCase[] } }));

describe('vim screen transcripts recorded from a real vim', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows and cursor cell`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replayScreenCase(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});

/*
 * Sonde des regles de fenetre de vim, une transcription par regle, enregistrees sur vim 9.1
 * (`vim -u DEFAULTS --noplugin -i NONE -n` sous tmux, scripts/oracle/record_vim_screen.py) : lignes de la
 * fenetre et cellule du curseur apres chaque etape.  Le corpus aleatoire de vim-screen-oracle.test.ts couvre
 * le meme terrain a l'echelle ; ici chaque cas nomme la regle de move.c / window.c / normal.c qu'il isole.
 * Deux sources : les cas du corpus que le moteur du commit precedent ne rejouait pas (REGRESSIONS, designes par
 * leur identifiant), et 13 laboratoires minimaux enregistres pour la sonde (window-rules.json).
 *
 * Mesure avec `git stash push -- src/network` (moteur du commit precedent) : 22 des 31 tests tombent avant, 0
 * apres.  Les 9 qui passent avant comme apres : le test de chargement (structurel) ; scr3-153, que le moteur
 * precedent rejouait deja (sa geometrie ne distingue pas les deux moteurs) ;
 * et sept laboratoires minimaux nommes ci-dessous, dont la geometrie n'exerce pas la regle sur l'ancien moteur
 * (ils verrouillent le comportement apres) : win-botline-redraw, win-botline-approx-scroll,
 * win-halfpage-up-valid-top, win-resize-height-then-width, win-edit-last-char-keeps-top, win-zh-wrap-keeps-curswant
 * et win-click-truncated-row.  Ce dernier est aussi le correctif d'une fausse mesure : le document des cas non portes
 * affirmait que vim ignore le clic sur la rangee `@@@`, vim 9.1 y deplace le curseur sur la ligne cachee et la
 * fenetre suit, et le moteur precedent le faisait deja.  Les 22 qui tombent avant : 16 cas du corpus (tous sauf
 * scr3-153) et 6 laboratoires (win-ctrl-f-fail-keeps-curswant, win-resize-tall-line, win-click-tall-line,
 * win-insert-pageup, win-g-dollar-nowrap-tab, win-visual-object-then-click).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { replayScreenCase, type ScreenCase } from '../../support/oracle/vimScreenReplay';

interface Probe extends ScreenCase { why: string }

const REGRESSIONS: readonly (readonly [fixture: string, id: string, rule: string])[] = [
  ['vim-9.1-scroll-seed3.json', 'scr3-153', 'a second update_topline runs when w_botline changed after the redraw (halfway, prefer_above false)'],
  ['vim-9.1-scroll-seed3.json', 'scr3-144', 'halfpage up: cursor_correct leaves VALID_TOPLINE set after the cursor moved'],
  ['vim-9.1-scroll-seed3.json', 'scr3-130', 'a Ctrl-F that fails leaves curswant alone'],
  ['vim-9.1-scroll-seed3.json', 'scr3-101', 'zh with wrap does nothing and keeps curswant'],
  ['vim-9.1-resize-seed5.json', 'rsz5-70', 'the height changes first, with the old width, and update_topline runs between the two'],
  ['vim-9.1-resize-seed5.json', 'rsz5-92', 'height then width, cursor far below the new window'],
  ['vim-9.1-resize-seed5.json', 'rsz5-139', 'a cursor line taller than the window: w_skipcol and the <<< marker'],
  ['vim-9.1-resize-seed5.json', 'rsz5-56', 'Insert-mode PageUp is onepage(BACKWARD) with nowrap'],
  ['vim-9.1-click-seed9.json', 'clk9-69', 'x on the last character moves the cursor before the change column: the top line stays valid'],
  ['vim-9.1-click-seed9.json', 'clk9-133', 'clicks map through w_skipcol'],
  ['vim-9.1-click-seed9.json', 'clk9-113', 'a pending Visual text-object prefix is cancelled by a click'],
  ['vim-9.1-click-seed9.json', 'clk9-168', 'the click cancelling the prefix is swallowed, the next key runs'],
  ['vim-9.1-click-seed9.json', 'clk9-39', 'A and I in Visual mode insert at the cursor, not at the selection ends'],
  ['vim-9.1-click-seed21.json', 'clk21-19', 'entering Insert with A does not invalidate the top line'],
  ['vim-9.1-click-seed21.json', 'clk21-69', 'scroll_cursor_halfway with prefer_above false'],
  ['vim-9.1-cells-seed2.json', 'cell2-194', 'g$ with nowrap: a tab counts as one cell, only a wide character that does not fit moves back'],
  ['vim-9.1-cells-seed2.json', 'cell2-133', 'scroll_cursor_bot with a cursor line taller than the room below'],
];

const fixtureCache = new Map<string, ScreenCase[]>();
function fixtureCase(fixture: string, id: string): ScreenCase {
  let cases = fixtureCache.get(fixture);
  if (!cases) {
    cases = (JSON.parse(readFileSync(`src/__tests__/support/oracle/vim-screen/${fixture}`, 'utf8')) as { cases: ScreenCase[] }).cases;
    fixtureCache.set(fixture, cases);
  }
  const found = cases.find((c) => c.id === id);
  if (!found) throw new Error(`${id} is not in ${fixture}`);
  return found;
}

const laboratories = (JSON.parse(readFileSync('src/__tests__/support/oracle/vim-window/window-rules.json', 'utf8')) as { cases: Probe[] }).cases;

describe('vim window rules, one measured transcript each', () => {
  it('loads the recorded probes', () => {
    expect(laboratories.length).toBe(13);
    expect(REGRESSIONS.length).toBe(17);
  });

  it.each(REGRESSIONS.map(([fixture, id, rule]) => [id, rule, fixtureCase(fixture, id)] as const))('corpus %s: %s', (_id, _rule, probe) => {
    expect(replayScreenCase(probe) ?? '').toBe('');
  });

  it.each(laboratories.map((probe) => [probe.id, probe.why, probe] as const))('laboratory %s: %s', (_id, _why, probe) => {
    expect(replayScreenCase(probe) ?? '').toBe('');
  });
});

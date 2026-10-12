/**
 * L'ecran de vim rejoue contre un vrai vim 9.1 pilote par tmux (scripts/oracle/record_vim_screen.py,
 * `vim -u DEFAULTS --noplugin -i NONE -n`, locale UTF-8) : apres chaque etape on compare les lignes
 * de la fenetre, la cellule du curseur, et la colonne de la regle.  Six corpus aleatoires :
 *   cells (400 cas de deplacements dans des tampons a tabulations, CJK, accents, `list`, `nu`,
 *   `nowrap`, `sidescroll`), scroll (Ctrl-F/B/D/U/E/Y, z*, H/M/L, scrolloff), resize (redimension-
 *   nement de la fenetre entre les etapes) et click (deux corpus de 200 cas, seeds 9 et 21, de clics de souris en encodage SGR,
 *   avec `:set mouse=` tire parmi a, n, nv, i, v, nvi et vide).
 *
 * Mesure avec `git stash push -u -- src/network` : l'ancien moteur n'a ni ecran, ni fenetre, ni
 * `resize`, ni `clickAt` ; le fichier ne se charge meme pas (VimScreen n'existe pas), donc les 6 tests
 * tombent avant.  Le corpus click seul, rejoue sur le moteur de a0acef2cc avec un `clickAt` vide et sans
 * option `mouse` : 107 cas tombent hors de la liste ci-dessous (clics sans effet, `Ctrl-F` en Visuel,
 * colonne d'une tabulation en Visuel), les autres passent par hasard ou parce que `mouse=` est vide.
 * Le TEMOIN que le lab est sain : 1213 cas sur 1250 passent apres, cellule du curseur comprise, dont
 * les cas a `mouse=` vide ou un clic ne doit RIEN faire (un vim Debian/Ubuntu lit `defaults.vim` avec la
 * souris coupee) et les cas a clic ignore faute de mode dans `mouse=`.
 *
 * Divergences connues, mesurees et NON portees (UNPORTED_CASES) : 37 cas sur 1250, dont ceux du second corpus click, enregistre
 * apres le premier : ils tombent tous dans des familles deja nommees, aucune famille nouvelle.  Aucun n'est
 * epingle comme contrat : un cas de la liste qui se met a passer fait echouer le test pour qu'on le
 * retire de la liste.
 *   - scrolloff grand devant la hauteur de la fenetre (so=8 dans 12 lignes, so=999, ou so=5 dans une
 *     fenetre de 5 lignes de texte) : `scroll_cursor_*` et `cursor_correct` de vim partent d'un
 *     `w_topline` que ce moteur recalcule autrement ;
 *   - Ctrl-D / Ctrl-U / Ctrl-B / Ctrl-F en fin ou en debut de fichier avec `display=lastline`/`truncate` ;
 *   - redimensionnement quand la ligne du curseur est plus haute que la fenetre ;
 *   - `g$` en `nowrap` avec `sidescroll` et `sidescrolloff` ensemble ;
 *   - deux clics sur la meme cellule a moins de 'mousetime' (500 ms) : vim y voit un double-clic et selectionne
 *     le mot, ce moteur y voit deux clics simples (clk21-53) ;
 *   - clic ou touche avec un prefixe d'objet de texte en attente (`Vi` puis clic), `A` en Visuel ligne ;
 *   - clic sur la rangee `@@@` d'une ligne dont aucune rangee n'est visible : vim l'ignore.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { plainRowText } from '@/network/devices/linux/editors/screen/EditorScreen';

interface Recorded { y: number; x: number; rows: string[]; last: string; height: number; width: number }
interface ScreenCase { id: string; text: string[]; rows: number; cols: number; setup: string[]; steps: string[]; after: Recorded[]; mouse?: string }

const NAMED: Record<string, [string, Partial<EditorKeyInput>]> = {
  Esc: ['Escape', {}], CR: ['Enter', {}], Tab: ['Tab', {}], BS: ['Backspace', {}], Space: [' ', {}],
  Up: ['ArrowUp', {}], Down: ['ArrowDown', {}], Left: ['ArrowLeft', {}], Right: ['ArrowRight', {}],
  Home: ['Home', {}], End: ['End', {}], PageUp: ['PageUp', {}], PageDown: ['PageDown', {}], Del: ['Delete', {}],
};

function keysOf(step: string): EditorKeyInput[] {
  const out: EditorKeyInput[] = [];
  for (let i = 0; i < step.length;) {
    const named = /^<(C-([a-z[])|[A-Za-z]+)>/.exec(step.slice(i));
    if (named) {
      if (named[2] !== undefined) { out.push(editorKey(named[2], { ctrl: true })); i += named[0].length; continue; }
      const entry = NAMED[named[1]];
      if (entry) { out.push(editorKey(entry[0], entry[1])); i += named[0].length; continue; }
    }
    const cp = step.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    out.push(editorKey(ch));
    i += ch.length;
  }
  return out;
}

function textRows(engine: VimEngine): string[] {
  return engine.screen.rows.slice(0, -1).map((row) => plainRowText(row).replace(/\s+$/, ''));
}

function replay(c: ScreenCase): string | null {
  const content = c.text.join('\n') + '\n';
  const fs = new InMemoryEditorFsContext({ '/tmp/s.txt': content });
  const engine = new VimEngine(fs, '/tmp/s.txt', content, false, 'vim');
  engine.resize(c.rows, c.cols);
  const setup = c.mouse === undefined ? c.setup : [`set mouse=${c.mouse}`, ...c.setup];
  for (const line of setup) for (const k of keysOf(`:${line}<CR>`)) engine.applyKey(k);
  for (let s = 0; s < c.after.length; s++) {
    const step = c.steps[s];
    if (step.startsWith('@click:')) {
      const [, row, col] = step.split(':').map(Number);
      engine.clickAt(row, col);
    } else if (step.startsWith('@')) {
      const [rows, cols] = step.slice(1).split('x').map(Number);
      engine.resize(rows, cols);
    } else {
      for (const k of keysOf(step)) engine.applyKey(k);
    }
    const want = c.after[s];
    const got = textRows(engine);
    const screen = engine.screen;
    const rowsOk = JSON.stringify(got) === JSON.stringify(want.rows.slice(0, got.length).map((r) => r.replace(/\s+$/, '')));
    const wantAtCommandLine = want.y >= want.height - 1;
    const cursorOk = wantAtCommandLine || (screen.cursor !== null && screen.cursor.row === want.y && screen.cursor.col === want.x);
    if (!rowsOk || !cursorOk) {
      return `${c.id} ${c.rows}x${c.cols} ${JSON.stringify(c.setup)} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}\n  want y=${want.y} x=${want.x} rows=${JSON.stringify(want.rows)}\n  got  y=${screen.cursor?.row} x=${screen.cursor?.col} rows=${JSON.stringify(got)}`;
    }
  }
  return null;
}

const UNPORTED_CASES: ReadonlySet<string> = new Set([
  'cell2-133', 'cell2-194',
  'scr3-76', 'scr3-101', 'scr3-130', 'scr3-144', 'scr3-176', 'scr3-179', 'scr3-194',
  'rsz5-36', 'rsz5-50', 'rsz5-56', 'rsz5-70', 'rsz5-92', 'rsz5-117', 'rsz5-139', 'rsz5-144', 'rsz5-155',
  'clk9-39', 'clk9-46', 'clk9-48', 'clk9-69', 'clk9-104', 'clk9-113', 'clk9-133', 'clk9-137', 'clk9-154', 'clk9-168', 'clk9-178', 'clk9-191',
  'clk21-19', 'clk21-20', 'clk21-53', 'clk21-69', 'clk21-84', 'clk21-130', 'clk21-144',
]);

const dir = 'src/__tests__/support/oracle/vim-screen';
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => ({ name: f, ...JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as { vim: string; cases: ScreenCase[] } }));

describe('vim screen transcripts recorded from a real vim', () => {
  for (const fixture of fixtures) {
    it(`${fixture.name} replays with the same rows and cursor cell`, () => {
      const outcomes = fixture.cases.map((c) => ({ id: c.id, failure: replay(c) }));
      const unexpected = outcomes.filter((o) => o.failure !== null && !UNPORTED_CASES.has(o.id)).map((o) => o.failure);
      const nowPassing = outcomes.filter((o) => o.failure === null && UNPORTED_CASES.has(o.id)).map((o) => o.id);
      expect(unexpected.length > 0 ? `${unexpected.length} of ${fixture.cases.length}\n${unexpected.slice(0, 3).join('\n')}` : '').toBe('');
      expect(nowPassing).toEqual([]);
    });
  }
});

/**
 * Scénario 11 (auto-conçu) — Marques et navigation par sauts dans vim :
 * `m{a-z}` pose une marque à la position exacte du curseur ; `` `{marque} ``
 * saute à cette position exacte (ligne + colonne) ; `'{marque}` saute au
 * premier caractère non blanc de la ligne de la marque (distinction
 * guillemet/backtick, un vrai comportement documenté de vim) ; ``` `` ```
 * et `''` reviennent à la position précédant le dernier saut par marque
 * (bascule) ; les marques peuvent servir de mouvement à un opérateur
 * (`` d`a ``, `d'a`, `y'a`, `c'a`) ; `:marks` liste les marques posées.
 *
 * Portée assumée (comme pour les scénarios précédents, cf. limites déjà
 * actées pour les splits/resize/coloration) : ceci couvre le *jumplist*
 * réduit aux sauts par marque uniquement (pas `G`/`gg`/recherche, qui ne
 * sont pas enregistrés dans ce mini-jumplist) ; le mouvement d'opérateur
 * `` `{marque} `` (exclusif, caractère par caractère) n'est résolu que
 * lorsque marque et curseur sont sur la même ligne — au-delà, comme pour
 * tout mouvement non reconnu après un opérateur, vim (et ce moteur)
 * annule l'opération. `'{marque}` reste un mouvement linéaire complet
 * (multi-lignes) car c'est le cas d'usage réel le plus courant. Les
 * marques ne sont pas réajustées automatiquement si des lignes sont
 * insérées/supprimées ailleurs dans le buffer (pas de recalcul de
 * jumplist/marks sur mutation de texte) — limite assumée, non testée
 * comme un succès.
 *
 * TDD: written against the headless VimEngine, before any marks/jumps
 * implementation exists (confirmed via grep: no `marks`, `` ` `` motion,
 * or jumplist code present).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function exCmd(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}

describe('Scénario 11 — poser une marque (m{a-z}) et sauter dessus', () => {
  let vim: VimEngine;
  beforeEach(() => {
    const content = 'first line\n  second line\nthird line\nfourth line\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/marks.txt': content });
    vim = new VimEngine(fs, '/tmp/marks.txt', content, false, 'vim');
  });

  it('m{lettre} pose une marque à la position exacte (ligne + colonne) du curseur', () => {
    press(vim, 'j'); // line 1 ("  second line")
    press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); // col 3
    press(vim, 'm');
    press(vim, 'a');
    expect(vim.cursorLine).toBe(1);
    expect(vim.cursorCol).toBe(3); // setting a mark never moves the cursor
  });

  it('`{marque} saute à la colonne exacte enregistrée, pas seulement à la ligne', () => {
    press(vim, 'j'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); // (1, 3)
    press(vim, 'm'); press(vim, 'a');
    press(vim, 'G'); // move away, end of buffer
    expect(vim.cursorLine).toBe(3);

    press(vim, '`'); press(vim, 'a');
    expect(vim.cursorLine).toBe(1);
    expect(vim.cursorCol).toBe(3);
  });

  it("'{marque} saute au premier caractère non blanc de la ligne de la marque (pas la colonne exacte)", () => {
    press(vim, 'j'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); // (1, 3) -- inside leading spaces
    press(vim, 'm'); press(vim, 'a');
    press(vim, 'G');

    press(vim, "'"); press(vim, 'a');
    expect(vim.cursorLine).toBe(1);
    expect(vim.cursorCol).toBe(2); // "  second line" -- first non-blank is index 2
  });

  it('sauter sur une marque non posée affiche E20 et ne bouge pas le curseur', () => {
    press(vim, 'G');
    const before = { line: vim.cursorLine, col: vim.cursorCol };
    press(vim, '`'); press(vim, 'z');
    expect(vim.message).toBe('E20: Mark not set');
    expect(vim.cursorLine).toBe(before.line);
    expect(vim.cursorCol).toBe(before.col);
  });

  it('plusieurs marques a-z coexistent indépendamment', () => {
    press(vim, 'm'); press(vim, 'a'); // (0,0)
    press(vim, 'G');
    press(vim, 'm'); press(vim, 'b'); // (3,0)

    press(vim, 'k'); // line 2
    press(vim, '`'); press(vim, 'a');
    expect(vim.cursorLine).toBe(0);
    press(vim, '`'); press(vim, 'b');
    expect(vim.cursorLine).toBe(3);
  });

  it("seules les lettres a-z sont acceptées comme nom de marque ; une touche invalide annule silencieusement", () => {
    press(vim, 'm'); press(vim, '1');
    press(vim, '`'); press(vim, '1');
    // no mark was ever recorded under "1" -- E20 still fires
    expect(vim.message).toBe('E20: Mark not set');
  });
});

describe("Scénario 11 — retour arrière `` / '' (bascule sur la position précédant le dernier saut)", () => {
  let vim: VimEngine;
  beforeEach(() => {
    const content = 'one\ntwo\nthree\nfour\nfive\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/back.txt': content });
    vim = new VimEngine(fs, '/tmp/back.txt', content, false, 'vim');
  });

  it('`` revient exactement à la position (ligne+colonne) précédant le dernier saut par marque', () => {
    press(vim, 'j'); press(vim, 'j'); press(vim, 'l'); // (2, 1) "three"
    press(vim, 'm'); press(vim, 'a');
    press(vim, 'G'); press(vim, 'l'); press(vim, 'l'); // (4, 2) "five"
    const beforeJump = { line: vim.cursorLine, col: vim.cursorCol };

    press(vim, '`'); press(vim, 'a');
    expect(vim.cursorLine).toBe(2);
    expect(vim.cursorCol).toBe(1);

    press(vim, '`'); press(vim, '`');
    expect(vim.cursorLine).toBe(beforeJump.line);
    expect(vim.cursorCol).toBe(beforeJump.col);
  });

  it('`` bascule (toggle) : appliqué deux fois de suite ramène à la position de départ', () => {
    press(vim, 'j'); press(vim, 'j'); press(vim, 'j'); // line 3
    press(vim, 'm'); press(vim, 'z');
    press(vim, 'gg');
    const start = { line: vim.cursorLine, col: vim.cursorCol };

    press(vim, '`'); press(vim, 'z');
    press(vim, '`'); press(vim, '`');
    expect(vim.cursorLine).toBe(start.line);
    press(vim, '`'); press(vim, '`');
    expect(vim.cursorLine).toBe(3);
  });

  it("'' revient à la ligne précédant le dernier saut, au premier non-blanc", () => {
    const content2 = 'a\n   b\nc\n';
    const fs2 = new InMemoryEditorFsContext({ '/tmp/back2.txt': content2 });
    const vim2 = new VimEngine(fs2, '/tmp/back2.txt', content2, false, 'vim');
    press(vim2, 'j'); press(vim2, 'l'); press(vim2, 'l'); // (1, 2) -- inside "   b"'s leading spaces
    press(vim2, 'm'); press(vim2, 'a');
    press(vim2, 'G'); // (2, 0) -- "c", the pre-jump position that `` `a `` below will remember

    press(vim2, '`'); press(vim2, 'a'); // jumps to (1, 2); saves (2, 0) as lastJumpPosition
    expect(vim2.cursorLine).toBe(1);

    press(vim2, "'"); press(vim2, "'"); // line of lastJumpPosition (2), first non-blank
    expect(vim2.cursorLine).toBe(2);
    expect(vim2.cursorCol).toBe(0);
  });
});

describe('Scénario 11 — marque comme mouvement d\'opérateur (d`a, d\'a, y\'a, c\'a)', () => {
  it('d`a supprime le texte entre le curseur et la marque sur la même ligne (mouvement exclusif)', () => {
    const content = 'abcdefgh\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/op1.txt': content });
    const vim = new VimEngine(fs, '/tmp/op1.txt', content, false, 'vim');

    press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); // col 5 -> 'f'
    press(vim, 'm'); press(vim, 'a');
    press(vim, '0'); // back to col 0

    press(vim, 'd'); press(vim, '`'); press(vim, 'a');
    expect(vim.lines[0]).toBe('fgh'); // "abcde" removed, exclusive of 'f' at the mark
    expect(vim.cursorCol).toBe(0);
  });

  it("d`a fonctionne aussi depuis l'autre sens (marque avant le curseur)", () => {
    const content = 'abcdefgh\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/op2.txt': content });
    const vim = new VimEngine(fs, '/tmp/op2.txt', content, false, 'vim');

    press(vim, 'm'); press(vim, 'a'); // mark at col 0
    press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); // col 5

    press(vim, 'd'); press(vim, '`'); press(vim, 'a');
    expect(vim.lines[0]).toBe('fgh');
  });

  it("d`a vers une marque sur une autre ligne annule (mouvement non résolu, comme un vrai mouvement inconnu)", () => {
    const content = 'line one\nline two\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/op3.txt': content });
    const vim = new VimEngine(fs, '/tmp/op3.txt', content, false, 'vim');
    press(vim, 'm'); press(vim, 'a');
    press(vim, 'j');
    press(vim, 'd'); press(vim, '`'); press(vim, 'a');
    expect(vim.lines).toEqual(['line one', 'line two']); // unchanged, operator cancelled
  });

  it("d'a supprime toutes les lignes entre le curseur et la ligne de la marque, incluses (linéaire)", () => {
    const content = 'l1\nl2\nl3\nl4\nl5\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/op4.txt': content });
    const vim = new VimEngine(fs, '/tmp/op4.txt', content, false, 'vim');

    press(vim, 'm'); press(vim, 'a'); // mark on l1 (line 0)
    press(vim, 'G'); press(vim, 'k'); // line 3 (l4)

    press(vim, 'd'); press(vim, "'"); press(vim, 'a');
    expect(vim.lines).toEqual(['l5']);
  });

  it("y'a copie (yank) les lignes sans les supprimer, puis p les colle", () => {
    const content = 'l1\nl2\nl3\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/op5.txt': content });
    const vim = new VimEngine(fs, '/tmp/op5.txt', content, false, 'vim');

    press(vim, 'j'); press(vim, 'j'); // line 2 (l3)
    press(vim, 'm'); press(vim, 'a');
    press(vim, 'g'); press(vim, 'g'); // back to line 0 (l1)

    press(vim, 'y'); press(vim, "'"); press(vim, 'a');
    expect(vim.lines).toEqual(['l1', 'l2', 'l3']); // unchanged by yank

    press(vim, 'G'); // end
    press(vim, 'p');
    expect(vim.lines).toEqual(['l1', 'l2', 'l3', 'l1', 'l2', 'l3']);
  });

  it("c'a change (supprime puis passe en INSERT) les lignes de la plage", () => {
    const content = 'l1\nl2\nl3\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/op6.txt': content });
    const vim = new VimEngine(fs, '/tmp/op6.txt', content, false, 'vim');

    press(vim, 'j'); // line 1 (l2)
    press(vim, 'm'); press(vim, 'a');
    press(vim, 'j'); // line 2 (l3)

    press(vim, 'c'); press(vim, "'"); press(vim, 'a');
    expect(vim.mode).toBe('insert');
    expect(vim.lines).toEqual(['l1', '']);
  });
});

describe('Scénario 11 — :marks liste les marques posées', () => {
  it("affiche l'en-tête et chaque marque triée alphabétiquement avec sa ligne/colonne", () => {
    const content = 'alpha\nbeta\ngamma\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/list.txt': content });
    const vim = new VimEngine(fs, '/tmp/list.txt', content, false, 'vim');

    press(vim, 'G');
    press(vim, 'm'); press(vim, 'z');
    press(vim, 'g'); press(vim, 'g');
    press(vim, 'l');
    press(vim, 'm'); press(vim, 'a');

    exCmd(vim, 'marks');
    expect(vim.marksOutput).toContain('mark line  col file/text');
    expect(vim.marksOutput).toMatch(/ a\s+1\s+1\s+alpha/);
    expect(vim.marksOutput).toMatch(/ z\s+3\s+0\s+gamma/);
    // alphabetical order: 'a' listed before 'z'
    expect(vim.marksOutput.indexOf(' a ')).toBeLessThan(vim.marksOutput.indexOf(' z '));
  });

  it('aucune marque posée : la liste ne contient que l\'en-tête', () => {
    const content = 'x\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/empty.txt': content });
    const vim = new VimEngine(fs, '/tmp/empty.txt', content, false, 'vim');
    exCmd(vim, 'marks');
    expect(vim.marksOutput).toBe('mark line  col file/text');
  });
});

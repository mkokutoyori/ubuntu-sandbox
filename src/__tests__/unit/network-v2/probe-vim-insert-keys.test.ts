/*
 * Sonde des touches du mode Insertion de vim : Ctrl-T, Ctrl-D (et 0 Ctrl-D), Ctrl-E, Ctrl-Y, Ctrl-F, Ctrl-U,
 * Ctrl-W, Retour arriere et Tab, avec et sans 'autoindent', 'softtabstop' et 'shiftwidth'.  Chaque ligne
 * est une transcription mesuree sur vim 9.1 (`vim -u NONE -es`, backspace=indent,eol,start) : texte de
 * depart, options, touches, tampon et position du curseur (ligne, colonne, base 1) apres Echap.  Le corpus
 * aleatoire de vim-cursor-oracle.test.ts (vocabulaire `insert`, graines 71 et 72) couvre le meme terrain
 * a l'echelle ; cette sonde nomme les regles une a une pour qu'un echec dise laquelle a casse.
 *
 * Mesure avec `git stash push -- src/network` (moteur du commit precedent) : 20 des 32 cas tombent avant,
 * 0 apres.  Les 12 qui passent avant comme apres : trois TEMOINS de non-regression du Retour arriere
 * (descente jusqu'a la colonne 1, espace tape, jonction de deux lignes), deux cas ou la touche ne doit rien
 * faire et ne faisait rien (Ctrl-E sous une ligne trop courte, Ctrl-W au tout debut du tampon) et sept cas
 * ou l'ancienne suppression jusqu'au debut de la ligne ou du mot aboutit au meme tampon par un autre chemin
 * (ligne qui ne porte que son indentation, mot unique apres cc).  Ctrl-E, Ctrl-Y, Ctrl-F, Ctrl-T et Ctrl-D ne
 * faisaient rien ; Ctrl-U et Ctrl-W ignoraient le point de depart de l'insertion et l'indentation automatique.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

type Measured = readonly [label: string, text: string[], options: string, keys: string, lines: string[], position: [number, number]];

const MEASURED: readonly Measured[] = [
  ["autoindent: Ctrl-U after two typed spaces removes the whole line", ["  42,"], "autoindent", "o  <C-u>", ["  42,", ""], [2, 1]],
  ["autoindent: Ctrl-U stops at the indent when text was typed", ["  42,"], "autoindent", "ox<C-u>", ["  42,", "  "], [2, 2]],
  ["autoindent: a second Ctrl-U removes the indent", ["  42,"], "autoindent", "ox<C-u><C-u>", ["  42,", ""], [2, 1]],
  ["autoindent: Ctrl-U on the bare indent removes it", ["  42,"], "autoindent", "o<C-u>", ["  42,", ""], [2, 1]],
  ["autoindent: S then Ctrl-U stops at the indent", ["  42,"], "autoindent", "Sx<C-u>", ["  "], [1, 2]],
  ["autoindent: S then two Ctrl-U empties the line", ["  42,"], "autoindent", "Sx<C-u><C-u>", [""], [1, 1]],
  ["autoindent: cc then Ctrl-W stops at the indent", ["  42,"], "autoindent", "ccxy<C-w>", ["  "], [1, 2]],
  ["autoindent: cc then two Ctrl-W empties the line", ["  42,"], "autoindent", "ccxy<C-w><C-w>", [""], [1, 1]],
  ["autoindent: Ctrl-T on a bare indent line is still removed on Esc", ["  42,"], "autoindent", "o<C-t>", ["  42,", ""], [2, 1]],
  ["autoindent: Ctrl-T then text keeps the line", ["  42,"], "autoindent", "o<C-t>x", ["  42,", "\tx"], [2, 2]],
  ["autoindent: Backspace down to column 1 keeps the indent alive until it reaches column 1", ["    42,"], "autoindent", "o<BS><BS>", ["    42,", ""], [2, 1]],
  ["autoindent: Backspace to column 1 forgets the automatic indent", ["    42,"], "autoindent", "o<BS><BS><BS>", ["    42,", " "], [2, 1]],
  ["autoindent: a typed space forgets the automatic indent", ["    42,"], "autoindent", "o <BS>", ["    42,", "    "], [2, 4]],
  ["autoindent: Ctrl-U then Enter keeps the bare line empty and the new line unindented", ["    42,"], "autoindent", "o  <C-u><CR>x", ["    42,", "", "x"], [3, 1]],
  ["autoindent: Ctrl-E after cc copies the character below at the cursor column", ["    42,", "abcdefghijkl"], "autoindent", "cc<C-e>", ["    e", "abcdefghijkl"], [1, 5]],
  ["Ctrl-T twice from inside the indent cuts the tab where the cursor stands", ["  "], "shiftwidth=2", "Gi  <C-t><C-t>x", ["       x\t"], [1, 8]],
  ["Ctrl-T once pads the indent", ["  "], "shiftwidth=2", "Gi  <C-t>", ["      "], [1, 5]],
  ["Ctrl-T three times goes past a tab stop", ["  "], "shiftwidth=2", "Gi  <C-t><C-t><C-t>", ["\t  "], [1, 2]],
  ["Ctrl-D rounds to a multiple of shiftwidth", ["\t\t  x"], "shiftwidth=4", "A<C-d>", ["\t\tx"], [1, 3]],
  ["Ctrl-T rounds to a multiple of shiftwidth", ["   x"], "shiftwidth=4 noexpandtab", "A<C-t>", ["    x"], [1, 5]],
  ["0 Ctrl-D removes the indent and the zero", ["    a"], "autoindent", "A<CR>0<C-d>b", ["    a", "b"], [2, 1]],
  ["Tab under softtabstop swallows the white space before it, Ctrl-W stops where that began", ["a_b  -- "], "softtabstop=8", "A<Tab><C-w>", ["a_b  --"], [1, 7]],
  ["a second Ctrl-W goes on past the tabs", ["a_b  -- "], "softtabstop=8", "A<Tab><C-w><C-w>", ["a_b  "], [1, 5]],
  ["without softtabstop a Tab is one character and Ctrl-W stops before it", ["a_b  -- "], "softtabstop=0", "A<Tab><C-w>", ["a_b  -- "], [1, 8]],
  ["Tab absorbing a tab leaves the existing tab alone", ["\t    ab", "  \tb", "x\tbaz [1,2]. foo-bar"], "autoindent softtabstop=-1 shiftwidth=4", "j$C<Tab>", ["\t    ab", "\t ", "x\tbaz [1,2]. foo-bar"], [2, 2]],
  ["Ctrl-E then Ctrl-Y copy the character below then above", ["\t    ab", "  \tb", "x\tbaz [1,2]. foo-bar"], "autoindent softtabstop=-1 shiftwidth=4", "j$C<Tab><C-e><C-y>", ["\t    ab", "\t a ", "x\tbaz [1,2]. foo-bar"], [2, 4]],
  ["Ctrl-E copies the character below at the cursor column", ["ab", "cdef"], "", "A<C-e>", ["abe", "cdef"], [1, 3]],
  ["Ctrl-Y copies the character above at the cursor column", ["abcd", "ab"], "", "jA<C-y>", ["abcd", "abc"], [2, 3]],
  ["Ctrl-E does nothing when the line below is too short", ["abcd", "ab"], "", "A<C-e>", ["abcd", "ab"], [1, 4]],
  ["Ctrl-F inserts a literal ^F without cindent", ["a"], "", "i<C-f>", ["\u0006a"], [1, 1]],
  ["Ctrl-W at the very start of the buffer leaves the automatic indent alive", ["", "x"], "autoindent expandtab", "S<C-w><C-t>", ["", "x"], [1, 1]],
  ["Backspace joining two lines forgets the automatic indent", ["    foo\t", "x"], "autoindent", "jS<BS><CR>y", ["    foo\t", "    y"], [2, 5]],
];

const NAMED: Record<string, EditorKeyInput> = {
  CR: editorKey('Enter'), BS: editorKey('Backspace'), Esc: editorKey('Escape'), Tab: editorKey('Tab'),
  Left: editorKey('ArrowLeft'), Right: editorKey('ArrowRight'),
};

function keysOf(sequence: string): EditorKeyInput[] {
  const keys: EditorKeyInput[] = [];
  for (let i = 0; i < sequence.length;) {
    const token = /^<([A-Za-z]+|C-[a-z])>/.exec(sequence.slice(i));
    if (token) {
      keys.push(token[1].startsWith('C-') ? editorKey(token[1][2], { ctrl: true }) : NAMED[token[1]]);
      i += token[0].length;
      continue;
    }
    keys.push(editorKey(sequence[i]));
    i++;
  }
  return keys;
}

function run(text: string[], options: string, keys: string): { lines: readonly string[]; position: [number, number] } {
  const content = text.join('\n') + '\n';
  const vim = new VimEngine(new InMemoryEditorFsContext({ '/tmp/t.txt': content }), '/tmp/t.txt', content, false, 'vim');
  const typed = [...(options ? keysOf(`:set ${options}<CR>`) : []), ...keysOf(keys), editorKey('Escape')];
  for (const key of typed) vim.applyKey(key);
  return { lines: vim.lines, position: [vim.cursorLine + 1, vim.cursorCol + 1] };
}

describe('vim Insert-mode keys, measured on a real vim 9.1', () => {
  it.each(MEASURED)('%s', (_label, text, options, keys, lines, position) => {
    const got = run(text, options, keys);
    expect({ keys, ...got }).toEqual({ keys, lines, position });
  });
});

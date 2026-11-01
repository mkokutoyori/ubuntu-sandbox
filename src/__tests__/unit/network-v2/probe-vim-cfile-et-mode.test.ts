/**
 * vim 9.1 : `expand('<cfile>')` (le nom de fichier sous le curseur ou apres lui sur la ligne, les adresses `scheme://` etendues a `?` et `&`) et `mode()` ; 35 positions rejouees sur le vrai vim (`-es`, `cursor()`), `mode()` mesure sous tmux : « n » dans une commande, « i » dans CTRL-R = en insertion, « n » depuis le mode visuel (`:` l'a quitte).
 * Mesure de depart : `<cfile>` renvoyait le texte tel quel et `mode` etait inconnue (E117) : les 35 cas et les 3 cas de mode() tombent avant ; aucun temoin.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const FILE_NAMES: ReadonlyArray<readonly [readonly string[], number, number, string]> = [
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 1, 1, "abc"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 1, 4, "def"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 1, 5, "def"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 1, 7, "def"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 2, 1, "x"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 2, 2, "/etc/hosts"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 2, 5, "/etc/hosts"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 2, 14, "y"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 3, 1, ""],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 4, 3, "a.b-c_d+e,f"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 4, 9, "a.b-c_d+e,f"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 5, 1, "http://x.org/p?q=1&r=2"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 5, 8, "http://x.org/p?q=1&r=2"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 5, 15, "q=1"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 6, 1, "~/f.txt"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 6, 8, "g"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 7, 1, "foo"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 7, 2, "foo"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 8, 2, "b"],
  [["abc def", "x /etc/hosts y", "  ", "a.b-c_d+e,f", "http://x.org/p?q=1&r=2", "~/f.txt;g", "(foo)", "a:b", "C:\\w"], 9, 1, "C"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 13, "http://x.org/p?q=1&r=2"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 14, "http://x.org/p?q=1&r=2"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 16, "q=1"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 17, "q=1"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 18, "q=1"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 19, "r=2"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 1, 22, "r=2"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 2, 1, "see"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 2, 4, "http://a.b/c"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 2, 5, "http://a.b/c"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 2, 14, "http://a.b/c"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 2, 16, "http://a.b/c"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 3, 1, "ftp://h/f"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 3, 9, "ftp://h/f"],
  [["http://x.org/p?q=1&r=2", "see http://a.b/c). next", "ftp://h/f;g"], 3, 11, "g"]
];

function engineOn(lines: readonly string[]): VimEngine {
  const text = `${lines.join('\n')}\n`;
  return new VimEngine(new InMemoryEditorFsContext({ '/tmp/f': text }), '/tmp/f', text, false, 'vim', 'root');
}

function type(vim: VimEngine, keys: string): void {
  for (const character of keys) vim.applyKey(character === '\n' ? editorKey('Enter') : editorKey(character));
}

function evaluate(vim: VimEngine, expression: string): string {
  type(vim, `:echo ${expression}\n`);
  return vim.message;
}

describe('<cfile> et mode()', () => {
  FILE_NAMES.forEach(([lines, row, col, expected]) => {
    it(`${JSON.stringify(lines[row - 1])} @${col} -> ${JSON.stringify(expected)}`, () => {
      const vim = engineOn(lines);
      type(vim, `${row}G${col > 1 ? `${col - 1}l` : ''}`);
      expect(evaluate(vim, "expand('<cfile>')")).toBe(expected);
    });
  });

  it('mode() vaut n dans une commande', () => {
    expect(evaluate(engineOn(['a']), 'mode()')).toBe('n');
  });

  it("mode(1) vaut 'n' dans une commande", () => {
    expect(evaluate(engineOn(['a']), 'mode(1)')).toBe('n');
  });

  it('mode() vaut i dans CTRL-R = en insertion', () => {
    const vim = engineOn(['a']);
    type(vim, 'i');
    vim.applyKey(editorKey('r', { ctrl: true }));
    type(vim, '=mode()\n');
    expect(vim.content.startsWith('ia')).toBe(true);
  });
});

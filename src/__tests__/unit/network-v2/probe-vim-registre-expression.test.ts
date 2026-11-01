/**
 * vim 9.1 : le registre expression. CTRL-R = en insertion et "= en normal ouvrent l'invite « = », évaluent l'expression à Entrée (une expression vide reprend la dernière, Échap annule, une erreur laisse le tampon intact et laisse taper la suite), insèrent ou collent le résultat (liste = lignes, nombre = texte, v:null = « v:null ») ; CTRL-R {registre} insère un registre ; getreg('='), @=, getreg('=', 1), getregtype, setreg, let @= ; 29 séquences de touches rejouées sur le vrai vim (tampon de départ [L1, L2], curseur en 1,1), tampon final, exception éventuelle et valeur du registre « = » relevés.
 * Mesure de départ : le moteur n'avait ni CTRL-R en insertion, ni registre « = », ni getreg/setreg/getregtype ; les 29 séquences de touches et les cas de getreg/setreg tombent tous avant (aucun témoin : même les cas d'erreur laissaient le tampon sans le message attendu).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey, type EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

const CASES: ReadonlyArray<readonly [string, string, string, string]> = [
  ["ione \\<C-R>=5*5\\<CR> two", "", "['one 25 twoL1', 'L2']", "'25'"],
  ["i\\<C-R>=toupper('abc')\\<CR>!", "", "['ABC!L1', 'L2']", "'ABC'"],
  ["iab\\<C-R>=['p','q']\\<CR>cd", "", "['abp', 'q', 'cdL1', 'L2']", "'p q '"],
  ["ix\\<C-R>=1+\\<CR>y", "E15: Invalid expression: \"1+\"", "['xyL1', 'L2']", "''"],
  ["ix\\<C-R>=\\<CR>y", "E15: Invalid expression: \"\"", "['xyL1', 'L2']", "''"],
  ["i\\<C-R>=3*3\\<CR>\\<Esc>o\\<C-R>=\\<CR>", "", "['9L1', '9', 'L2']", "'9'"],
  ["i\\<C-R>=join(['a','b'],nr2char(10))\\<CR>", "", "['a', 'bL1', 'L2']", "'a b'"],
  ["i\\<C-R>=1.5\\<CR>", "", "['1.5L1', 'L2']", "'1.5'"],
  ["i\\<C-R>=1/0\\<CR>z", "", "['9223372036854775807zL1', 'L2']", "'9223372036854775807'"],
  ["i\\<C-R>=v:null\\<CR>|", "", "['v:null|L1', 'L2']", "'v:null'"],
  ["i\\<C-R>=v:true\\<CR>|", "", "['v:true|L1', 'L2']", "'v:true'"],
  ["i\\<C-R>=[]\\<CR>|", "", "['|L1', 'L2']", "''"],
  ["i\\<C-R>={}\\<CR>|", "E731: Using a Dictionary as a String", "['|L1', 'L2']", "''"],
  ["\"=5+5\\<CR>p", "", "['L101', 'L2']", "'10'"],
  ["\"=[1,2]\\<CR>P", "", "['1', '2', 'L1', 'L2']", "'1 2 '"],
  ["\"=join(['x','y'],nr2char(10))\\<CR>p", "", "['Lx', 'y1', 'L2']", "'x y'"],
  ["\"=2*3\\<CR>3p", "", "['L6661', 'L2']", "'6'"],
  ["\"=2*3\\<CR>yy", "", "['L1', 'L2']", "'6'"],
  ["yy\"=1\\<CR>", "", "['L1', 'L2']", "'1'"],
  ["\"=abc\\<CR>p", "E121: Undefined variable: abc", "['L1', 'L2']", "''"],
  ["\"=\\<CR>p", "E15: Invalid expression: \"\"", "['L1', 'L2']", "''"],
  ["\"=1+1\\<CR>\"=\\<CR>p", "", "['L21', 'L2']", "'2'"],
  ["\"=5+5\\<CR>\"=\\<Esc>p", "", "['L101', 'L2']", "'10'"],
  ["i\\<C-R>=5*5\\<CR>\\<C-R>=\\<CR>", "", "['2525L1', 'L2']", "'25'"],
  ["\"=5*5\\<CR>i\\<C-R>\\<C-R>=\\<CR>", "", "['25L1', 'L2']", "'25'"],
  [":let @a = 'hello'\\<CR>ia\\<C-R>a|\\<C-R>\\<C-R>a\\<Esc>", "", "['ahello|helloL1', 'L2']", "''"],
  ["yyiX\\<C-R>\"Y\\<Esc>", "", "['XL1', 'YL1', 'L2']", "''"],
  [":let @= = '6*7'\\<CR>\"=\\<CR>p", "", "['L421', 'L2']", "'42'"],
  ["\"=5+5\\<CR>i\\<C-R>\\<C-R>=\\<CR>", "", "['10L1', 'L2']", "'10'"],
];

function keysOf(notation: string): EditorKeyInput[] {
  const keys: EditorKeyInput[] = [];
  for (let at = 0; at < notation.length; at++) {
    if (notation.startsWith('\\<C-R>', at)) { keys.push(editorKey('r', { ctrl: true })); at += 5; continue; }
    if (notation.startsWith('\\<CR>', at)) { keys.push(editorKey('Enter')); at += 4; continue; }
    if (notation.startsWith('\\<Esc>', at)) { keys.push(editorKey('Escape')); at += 5; continue; }
    keys.push(editorKey(notation[at]));
  }
  return keys;
}

function run(notation: string): { lines: string; message: string; register: string } {
  const fs = new InMemoryEditorFsContext({ '/tmp/f': 'L1\nL2\n' });
  const vim = new VimEngine(fs, '/tmp/f', 'L1\nL2\n', false, 'vim', 'root');
  let message = '';
  for (const key of keysOf(notation)) {
    vim.applyKey(key);
    if (message === '' && vim.message.startsWith('E')) message = vim.message;
  }
  if (vim.mode === 'insert') vim.applyKey(editorKey('Escape'));
  const lines = `[${vim.content.replace(/\n$/, '').split('\n').map((line) => `'${line}'`).join(', ')}]`;
  vim.applyKey(editorKey(':'));
  for (const ch of "$s#L2#\\=substitute(string(getreg('=')), nr2char(10), ' ', 'g')#") vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return { lines, message, register: vim.content.replace(/\n$/, '').split('\n').pop() ?? '' };
}

describe('registre expression de vim', () => {
  CASES.forEach(([notation, exception, expectedLines, expectedRegister], at) => {
    it(`${at + 1}. ${notation}`, () => {
      const outcome = run(notation);
      expect(outcome.lines).toBe(expectedLines);
      expect(outcome.message).toBe(exception);
      expect(outcome.register).toBe(expectedRegister);
    });
  });
});

const REGISTER_FUNCTIONS: ReadonlyArray<readonly [string, string]> = [
  ["setreg('a', 'one') . getreg('a') . getregtype('a')", "0onev"],
  ["setreg('a', ['p','q']) . string(getreg('a', 1, 1)) . getregtype('a')", "0['p', 'q']V"],
  ["setreg('a', 'x', 'l') . string(getreg('a')) . getregtype('a')", "0'x\n'V"],
  ["setreg('a', 'x') . setreg('a', 'y', 'a') . string(getreg('a'))", "00'xy'"],
  ["setreg('a', 'x', 'c') . string(getreg('a')) . getregtype('a')", "0'x'v"],
  ["setreg('a', \"x\\n\") . getregtype('a') . string(getreg('a', 0, 1))", "0V['x']"],
  ["string(getreg('z')) . string(getregtype('z'))", "''''"],
  ["setreg('a', 5) . string(getreg('a'))", "0'5'"],
  ["setreg('=', '3*3') . string(getreg('=')) . string(getreg('=', 1))", "0'9''3*3'"],
  ["setreg('a', 'x') . setreg('A', ['p','q']) . string(getreg('a', 0, 1)) . getregtype('a')", "00['x', 'p', 'q']V"],
  ["setreg('a', 'x') . setreg('A', \"p\\nq\") . string(getreg('a', 0, 1)) . getregtype('a')", "00['xp', 'q']v"],
  ["setreg('a', ['x','y']) . setreg('A', ['p']) . string(getreg('a', 0, 1)) . getregtype('a')", "00['x', 'y', 'p']V"],
  ["setreg('a', 'x', 'l') . setreg('A', 'p') . string(getreg('a', 0, 1)) . getregtype('a')", "00['x', 'p']v"],
  ["setreg('a', \"x\\ny\") . setreg('A', 'p') . string(getreg('a', 0, 1)) . getregtype('a')", "00['x', 'yp']v"],
  ["setreg('a', 'x') . setreg('A', 'p', 'l') . string(getreg('a', 0, 1)) . getregtype('a')", "00['xp']V"],
  ["setreg('a', 'x', 'l') . setreg('A', 'p', 'c') . string(getreg('a', 0, 1)) . getregtype('a')", "00['x', 'p']v"],
  ["setreg('a', 'x') . setreg('a', 'p', 'ac') . string(getreg('a', 0, 1)) . getregtype('a')", "00['xp']v"],
  ["setreg('a', 'x') . setreg('a', 'p', 'al') . string(getreg('a', 0, 1)) . getregtype('a')", "00['xp']V"],
];

describe('getreg, getregtype et setreg de vim', () => {
  REGISTER_FUNCTIONS.forEach(([expression, expected], at) => {
    it(`${at + 1}. ${expression}`, () => {
      const fs = new InMemoryEditorFsContext({ '/tmp/f': 'L1\nL2\n' });
      const vim = new VimEngine(fs, '/tmp/f', 'L1\nL2\n', false, 'vim', 'root');
      vim.applyKey(editorKey(':'));
      for (const ch of `1s#L1#\\=${expression}#`) vim.applyKey(editorKey(ch));
      vim.applyKey(editorKey('Enter'));
      expect(vim.content.slice(0, -'\nL2'.length)).toBe(expected);
    });
  });
});

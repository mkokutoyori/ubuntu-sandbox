/**
 * vim 9.1 : filereadable, isdirectory, readfile (options b et maximum, E484), getfsize et readdir (tri, filtre) sur un système de fichiers en mémoire ; valeurs relevées sur le vrai vim de cette machine dans un répertoire /tmp/vd (f.txt = « a\nb\n\nc » sans saut final, crlf.txt, empty.txt, sub/).
 * Mesure de départ : « E117: Unknown function » pour chacune. 15 des 16 cas tombent avant ; seul le témoin trim passe dans les deux états. Ajout : hostname, getpid et localtime (3 cas, les 3 tombent avant, E117). Ajout : environ() (3 cas, les 3 tombent avant).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function evaluate(expression: string): string {
  const fs = new InMemoryEditorFsContext({
    '/tmp/vd/f.txt': 'a\nb\n\nc', '/tmp/vd/crlf.txt': 'l1\r\nl2\r\n', '/tmp/vd/empty.txt': '', '/tmp/vd/sub/in.txt': 'z', '/tmp/vd/t.txt': 'x\n',
  }, () => '', undefined, '/tmp/vd');
  const vim = new VimEngine(fs, '/tmp/vd/t.txt', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content.replace(/\n$/, '');
}

describe('fonctions de fichier de vim', () => {
  const ORACLE: ReadonlyArray<readonly [string, string]> = [
    ['filereadable("f.txt")', '1'],
    ['filereadable("sub")', '0'],
    ['filereadable("nope")', '0'],
    ['isdirectory("sub")', '1'],
    ['isdirectory("f.txt")', '0'],
    ["string(readfile('f.txt'))", "['a', 'b', '', 'c']"],
    ["string(readfile('f.txt','',2))", "['a', 'b']"],
    ["string(readfile('f.txt','',-1))", "['c']"],
    ["string(readfile('crlf.txt'))", "['l1', 'l2']"],
    ["string(readfile('empty.txt'))", '[]'],
    ['getfsize("f.txt")', '6'],
    ['getfsize("nope")', '-1'],
    ['getfsize("empty.txt")', '0'],
    ['getcwd()', '/tmp/vd'],
    ["string(readdir('.', {n -> n =~ '^[cef]'}))", "['crlf.txt', 'empty.txt', 'f.txt']"],
  ];
  for (const [expression, expected] of ORACLE) it(expression, () => { expect(evaluate(expression)).toBe(expected); });
  it('témoin : trim', () => { expect(evaluate('trim(" a ")')).toBe('a'); });
});

describe('identité et horloge de vim', () => {
  it('hostname rend le nom de la machine', () => { expect(evaluate('hostname()')).toBe('vm'); });
  it('getpid rend le pid de l\'éditeur', () => { expect(evaluate('getpid()')).toBe('4321'); });
  it('localtime est un entier de secondes récent', () => { expect(Number(evaluate('localtime()'))).toBeGreaterThan(1.5e9); });
});

describe('environ', () => {
  const withEnvironment = (expression: string): string => {
    const fs = new InMemoryEditorFsContext({ '/tmp/vd/t.txt': 'x\n' }, () => '', undefined, '/tmp/vd');
    fs.useEnvironmentVariable('FOO', 'bar');
    fs.useEnvironmentVariable('EMPTY', '');
    const vim = new VimEngine(fs, '/tmp/vd/t.txt', 'x\n', false, 'vim', 'root');
    vim.applyKey(editorKey(':'));
    for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
    return vim.content.replace(/\n$/, '');
  };
  it('environ() est un dictionnaire des variables posées', () => { expect(withEnvironment('environ()["FOO"]')).toBe('bar'); });
  it('une variable vide y figure', () => { expect(withEnvironment('has_key(environ(), "EMPTY")')).toBe('1'); });
  it('type dictionnaire', () => { expect(withEnvironment('type(environ())')).toBe('4'); });
});

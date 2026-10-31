/**
 * vim 9.1 : filereadable, isdirectory, readfile (options b et maximum, E484), getfsize et readdir (tri, filtre) sur un système de fichiers en mémoire ; valeurs relevées sur le vrai vim de cette machine dans un répertoire /tmp/vd (f.txt = « a\nb\n\nc » sans saut final, crlf.txt, empty.txt, sub/).
 * Mesure de départ : « E117: Unknown function » pour chacune. 15 des 16 cas tombent avant ; seul le témoin trim passe dans les deux états.
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

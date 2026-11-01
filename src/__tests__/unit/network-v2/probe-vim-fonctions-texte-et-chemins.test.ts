/**
 * vim 9.1 (encoding=utf-8) : str2float, flatten, flattennew, slice, fmod, log10, isnan, strgetchar, byteidx, charidx, indexof, shellescape, simplify, pathshorten, isabsolutepath, fnamemodify (:h :t :r :e, :e répété), getenv, exists('$X') et v:shell_error ; valeurs relevées sur le vrai vim de cette machine.
 * Mesure de départ : « E117: Unknown function » pour chacune, exists('$X') testait la chaîne vide au lieu de la présence, v:shell_error restait vide. 41 des 43 cas tombent avant ; passent dans les deux états : le témoin trim et fnamemodify(".bashrc", ":e") (chaîne vide, que la fonction manque ou non).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function evaluate(expression: string, status = 0): string {
  const fs = new InMemoryEditorFsContext({}, () => '');
  fs.useEnvironmentVariable('FOO', 'bar');
  fs.useEnvironmentVariable('EMPTY', '');
  fs.writeFile('/tmp/f', 'x\n');
  (fs as unknown as { runChildShell: () => { output: string; status: number } }).runChildShell = () => ({ output: '', status });
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of `s#x#\\=${expression}#`) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content.replace(/\n$/, '');
}

const ORACLE: ReadonlyArray<readonly [string, string]> = [
  ['fnamemodify("/a/b.c.txt",":r")', '/a/b.c'],
  ['fnamemodify("/a/b.c.txt",":e")', 'txt'],
  ['fnamemodify("/a/b.c.txt",":h")', '/a'],
  ['fnamemodify("/a/b.c.txt",":t")', 'b.c.txt'],
  ['fnamemodify("b.txt",":h")', '.'],
  ['fnamemodify("/b.txt",":h")', '/'],
  ['fnamemodify("/a/b.c.txt",":r:r")', '/a/b'],
  ['fnamemodify("/a/b.c.txt",":e:e")', 'c.txt'],
  ['fnamemodify("a.b.c.d",":e:e:e")', 'b.c.d'],
  ['fnamemodify("a.b.c.d",":e:e:e:e")', 'b.c.d'],
  ['fnamemodify("a/",":h")', 'a'],
  ['fnamemodify(".bashrc",":e")', ''],
  ['simplify("a//b/./c/../d/")', 'a/b/d/'],
  ['simplify("../a/..")', '..'],
  ['simplify("a/b/../..")', '.'],
  ['pathshorten("/home/user/x.txt")', '/h/u/x.txt'],
  ['pathshorten("~/abc/def", 2)', '~/ab/def'],
  ['isabsolutepath("a")', '0'],
  ['shellescape("it\'s")', "'it'\\''s'"],
  ['str2float(" 1.5e2x")', '150.0'],
  ['str2float("-.5")', '-0.5'],
  ['str2float("0x10")', '16.0'],
  ['string(flatten([1,[2,[3,[4]]]], 1))', '[1, 2, [3, [4]]]'],
  ['string(flattennew([[1],[2]]))', '[1, 2]'],
  ['slice("héllo",1,3)', 'él'],
  ['string(slice([1,2,3],-2))', '[2, 3]'],
  ['string(slice([1,2,3],5))', '[]'],
  ['strgetchar("héllo",1)', '233'],
  ['strgetchar("abc",3)', '-1'],
  ['byteidx("héllo",2)', '3'],
  ['byteidx("héllo",6)', '-1'],
  ['charidx("héllo",2)', '1'],
  ['string(indexof([1,2,3],"v:val>1"))', '1'],
  ['string(indexof([1,2,3],"v:val>1",{"startidx":-1}))', '2'],
  ['string(fmod(-5.5,2))', '-1.5'],
  ['string(log10(1000))', '3.0'],
  ['string(isnan(0.0/0.0))', '1'],
  ['getenv("FOO")', 'bar'],
  ['string(getenv("NOPE_X"))', 'v:null'],
  ['exists("$EMPTY")', '1'],
  ['string(getenv("EMPTY"))', 'v:null'],
];

describe('fonctions de texte et de chemin de vim', () => {
  for (const [expression, expected] of ORACLE) it(expression, () => { expect(evaluate(expression)).toBe(expected); });
  it('v:shell_error suit le dernier system()', () => { expect(evaluate('system("false") . v:shell_error', 1)).toBe('1'); });
  it('témoin : trim', () => { expect(evaluate('trim(" a ")')).toBe('a'); });
});

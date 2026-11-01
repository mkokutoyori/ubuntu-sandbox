/**
 * vim 9.1 : `:function`, `:call`, `:echo`, `:return`, `:if`/`:for`/`:while`, `:execute`, `:source`, `:delfunction`, les portées l: a: s: et les fonctions de dictionnaire. 70 scripts rejoués sur le vrai vim (`vim -Nu NONE -es -S`, curseur en ligne 1, tampon [L1, L2]) : les lignes affichées par :echo et les erreurs, dans l'ordre erreurs puis affichages.
 * Mesure de départ : le moteur n'avait ni :function, ni :call, ni :echo, ni :source ; les 70 cas tombent avant, sans témoin autre que les cas dont la sortie attendue est vide.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const SCRIPTS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo Add(1, 2)"], "3"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo Add(1)"], "E119: Not enough arguments for function: Add"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo Add(1, 2, 3)"], "E118: Too many arguments for function: Add"],
  [["echo Nope(1)"], "E117: Unknown function: Nope"],
  [["function! Fact(n)", "  if a:n <= 1", "    return 1", "  elseif a:n > 100", "    return 0", "  else", "    return a:n * Fact(a:n - 1)", "  endif", "endfunction", "echo Fact(10)"], "3628800"],
  [["function! Many(first, ...)", "  return [a:first, a:0, a:000]", "endfunction", "echo Many(1)"], "[1, 0, []]"],
  [["function! Many(first, ...)", "  return [a:first, a:0, a:000]", "endfunction", "echo Many(1, 2, 3)"], "[1, 2, [2, 3]]"],
  [["function! Many(first, ...)", "  return [a:first, a:0, a:000, a:1]", "endfunction", "echo Many(1, 'x')"], "[1, 1, ['x'], 'x']"],
  [["function! Many(first, ...)", "  return a:first", "endfunction", "echo Many()"], "E119: Not enough arguments for function: Many"],
  [["function! Loc()", "  let g:z = 5", "  let q = 7", "  return exists('q') . exists('g:q') . exists('l:q')", "endfunction", "echo Loc() g:z"], "101 5"],
  [["function! Loc()", "  let q = 7", "endfunction", "call Loc()", "echo exists('q')"], "0"],
  [["let x = 1", "function! Shadow()", "  let x = 2", "  return x", "endfunction", "echo Shadow() x"], "2 1"],
  [["let x = 1", "function! Glob()", "  return x", "endfunction", "echo Glob()"], "E121: Undefined variable: x\n0"],
  [["let x = 1", "function! Glob()", "  return g:x", "endfunction", "echo Glob()"], "1"],
  [["function! Wr(n)", "  let a:n = 3", "endfunction", "echo Wr(1)"], "E46: Cannot change read-only variable \"a:n\"\n0"],
  [["function! Nothing()", "endfunction", "echo Nothing()"], "0"],
  [["function! Nothing()", "endfunction", "echo string(Nothing())"], "0"],
  [["function! Bump()", "  let s:c = get(s:, 'c', 0) + 1", "  return s:c", "endfunction", "echo Bump() Bump()"], "1 2"],
  [["function! Bump()", "  let s:c = get(s:, 'c', 0) + 1", "  return s:c", "endfunction", "call Bump()", "echo s:c"], "1"],
  [["function! NoAbort()", "  let x = 1", "  echo undefinedvar", "  let y = 2", "  return x + y", "endfunction", "echo NoAbort()"], "E121: Undefined variable: undefinedvar\n3"],
  [["function! WithAbort() abort", "  let x = 1", "  echo undefinedvar", "  return 9", "endfunction", "echo WithAbort()"], "E121: Undefined variable: undefinedvar\n-1"],
  [["function! Loop()", "  let s = 0", "  for i in range(1, 10)", "    if i == 3 | continue | endif", "    if i == 8 | break | endif", "    let s += i", "  endfor", "  let n = 0", "  while n < 5", "    let n += 1", "  endwhile", "  return [s, n]", "endfunction", "echo Loop()"], "[25, 5]"],
  [["function! Pairs()", "  let out = []", "  for [a, b] in [[1,2],[3,4]]", "    call add(out, a + b)", "  endfor", "  return out", "endfunction", "echo Pairs()"], "[3, 7]"],
  [["function! Chars()", "  let out = ''", "  for c in 'abc'", "    let out .= toupper(c)", "  endfor", "  return out", "endfunction", "echo Chars()"], "ABC"],
  [["function! lower()", "endfunction"], "E128: Function name must start with a capital or \"s:\": lower()\nE193: :endfunction not inside a function"],
  [["function! Fact(n)", "endfunction", "function Fact(n)", "endfunction"], "E122: Function Fact already exists, add ! to replace it"],
  [["function Dup()", "endfunction", "function Dup()", "endfunction", "echo 'x'"], "E122: Function Dup already exists, add ! to replace it\nx"],
  [["function! Mk(n)", "  return {x -> x + a:n}", "endfunction", "let F = Mk(10)", "echo F(5)"], "15"],
  [["function! Mk()", "  let k = 3", "  return {x -> x * k}", "endfunction", "echo map([1,2,3], Mk())"], "[0, 3, 6]"],
  [["function! Rec(n)", "  return Rec(a:n + 1)", "endfunction", "echo Rec(1)"], "E132: Function call depth is higher than 'maxfuncdepth'\n0"],
  [["function! Dd() dict", "  return 1", "endfunction", "echo Dd()"], "E725: Calling dict function without Dictionary: Dd"],
  [["let d = {'n': 4}", "function! d.get() dict", "  return self.n", "endfunction", "echo d.get()"], "4"],
  [["let d = {'n': 4}", "function! d.get() dict", "  return self.n", "endfunction", "function! d.get() dict", "endfunction"], ""],
  [["let d = {'n': 4}", "function! d.add(k) dict", "  let self.n += a:k", "  return self.n", "endfunction", "echo d.add(2) d.add(3) d.n"], "6 9 9"],
  [["function! Rg() range", "  return [a:firstline, a:lastline]", "endfunction", "echo Rg()"], "[1, 1]"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo exists('*Add') exists('*Nope')"], "1 0"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "delfunction Add", "echo exists('*Add')"], "0"],
  [["delfunction Nope"], "E117: Unknown function: Nope"],
  [["delfunction! Nope", "echo 1"], "1"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "let F = function('Add')", "echo F(1, 2)"], "3"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "let F = function('Add', [10])", "echo F(2)"], "12"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo map([1,2], {_, v -> Add(v, 1)})"], "[2, 3]"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo call('Add', [3, 4])"], "7"],
  [["function! Add(a, b)", "  return a:a + a:b", "endfunction", "echo string(function('Add'))"], "function('Add')"],
  [["echo function('Nope')"], "E700: Unknown function: Nope\n0"],
  [["execute 'echo 1+1' '| echo \"x\"'"], "2\nx"],
  [["if 0 | echo 'no' | else | echo 'yes' | endif"], "yes"],
  [["if 1 | echo 'a' | elseif 1 | echo 'b' | endif"], "a"],
  [["for [a, b] in [[1,2],[3,4]] | echo a+b | endfor"], "3\n7"],
  [["for ch in 'ab' | echo ch | endfor"], "a\nb"],
  [["let i = 0", "while i < 4 | let i += 1 | if i == 2 | continue | endif | echo i | endwhile"], "1\n3\n4"],
  [["echo a:"], "E121: Undefined variable: a:"],
  [["echo type(g:)"], "4"],
  [["echo 1 2 'three' [4, 'five']"], "1 2 three [4, 'five']"],
  [["echon 'a' 'b'", "echon 'c'"], "abc"],
  [["endif"], "E580: :endif without :if: endif"],
  [["endwhile"], "E588: :endwhile without :while: endwhile"],
  [["else"], "E581: :else without :if: else"],
  [["endfunction"], "E193: :endfunction not inside a function"],
  [["function! S(...)", "  let t = 0", "  for v in a:000", "    let t += v", "  endfor", "  return t", "endfunction", "echo S(1, 2, 3, 4)"], "10"],
  [["function! Cnt(l)", "  call add(a:l, len(a:l))", "endfunction", "let L = []", "call Cnt(L)", "call Cnt(L)", "echo L"], "[0, 1]"],
  [["function! Dup(a, a)", "endfunction"], "E853: Duplicate argument name: a\nE193: :endfunction not inside a function"],
  [["function! Bad(1x)", "endfunction"], "E125: Illegal argument: 1x)\nE193: :endfunction not inside a function"],
  [["function! Mod() abort", "  let x = 1", "  unlet x", "  return exists('x')", "endfunction", "echo Mod()"], "0"],
  [["function! Early(n)", "  if a:n", "    return 'yes'", "  endif", "  return 'no'", "endfunction", "echo Early(1) Early(0)"], "yes no"],
  [["function! Retv()", "  return", "endfunction", "echo Retv()"], "0"],
  [["function! Ex()", "  execute 'let g:made = 42'", "endfunction", "call Ex()", "echo g:made"], "42"],
  [["function! Nm()", "  normal! ihi", "endfunction", "call Nm()", "echo getline(1)"], "hiL1"],
  [["function! Ts(...)", "  return a:0 ? a:1 : 'none'", "endfunction", "echo Ts() Ts('v')"], "none v"],
  [["function! Nest()", "  function! Inner()", "    return 1", "  endfunction", "  return 2", "endfunction", "echo Nest()", "echo Inner()"], "2\n1"],
];

function run(script: readonly string[]): string {
  const fs = new InMemoryEditorFsContext({ '/tmp/f': 'L1\nL2\n', '/tmp/s.vim': `${script.join('\n')}\n` });
  const vim = new VimEngine(fs, '/tmp/f', 'L1\nL2\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const character of 'source /tmp/s.vim') vim.applyKey(editorKey(character));
  vim.applyKey(editorKey('Enter'));
  return vim.message;
}

describe('scripts vim : fonctions utilisateur', () => {
  SCRIPTS.forEach(([script, expected], at) => {
    it(`${at + 1}. ${script.join(' | ').slice(0, 90)}`, () => {
      expect(run(script)).toBe(expected);
    });
  });
});

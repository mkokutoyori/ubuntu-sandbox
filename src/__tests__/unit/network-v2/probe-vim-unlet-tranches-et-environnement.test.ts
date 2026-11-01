/**
 * vim 9.1 : « unlet » d'éléments (d['k'], d.k, l[i], l[a:b], imbriqués ; E716 et E684 même avec « ! »), « let l[a:b] = liste » (E709, E710, E711, affectation élément par élément avant l'erreur, +=), « let $VAR » / « unlet $VAR » (variable d'environnement de vim, visible de getenv, environ, exists('$X') et du shell de system()) ; 64 commandes rejouées EN SÉQUENCE sur le vrai vim, sortie de chaque commande et de chaque expression.
 * Mesure de départ : unlet n'acceptait que des noms nus (E108), let refusait les tranches et $VAR. 52 des 64 cas tombent avant ; 12 passent dans les deux états (les « let » d'initialisation et les lectures dont le résultat est déjà celui d'avant).
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const STEPS: ReadonlyArray<readonly [string, string]> = [
  ["let d = {'a': 1, 'b': {'c': [1,2,3]}}", "ok"],
  ["let l = [1,2,3,4,5]", "ok"],
  ["unlet d['a']", "ok"],
  ["unlet d['zz']", "ERR E716: Key not present in Dictionary: \"zz\""],
  ["unlet! d['zz']", "ERR E716: Key not present in Dictionary: \"zz\""],
  ["unlet d.b.c[0]", "ok"],
  ["=string(d)", "{'b': {'c': [2, 3]}}"],
  ["unlet l[1]", "ok"],
  ["=string(l)", "[1, 3, 4, 5]"],
  ["unlet l[1:2]", "ok"],
  ["=string(l)", "[1, 5]"],
  ["unlet l[9]", "ERR E684: List index out of range: 9"],
  ["unlet! l[9]", "ERR E684: List index out of range: 9"],
  ["unlet l[-1]", "ok"],
  ["=string(l)", "[1]"],
  ["let l = [1,2,3,4,5]", "ok"],
  ["unlet l[1:]", "ok"],
  ["=string(l)", "[1]"],
  ["let l = [1,2,3,4,5]", "ok"],
  ["unlet l[:1]", "ok"],
  ["=string(l)", "[3, 4, 5]"],
  ["let l = [1,2,3,4,5]", "ok"],
  ["let l[1:2] = [7,8]", "ok"],
  ["=string(l)", "[1, 7, 8, 4, 5]"],
  ["let l[1:2] = [7]", "ERR E711: List value does not have enough items"],
  ["=string(l)", "[1, 7, 8, 4, 5]"],
  ["let l[1:2] = [7,8,9]", "ERR E710: List value has more items than targets"],
  ["=string(l)", "[1, 7, 8, 4, 5]"],
  ["let l[:1] = [0]", "ERR E711: List value does not have enough items"],
  ["=string(l)", "[0, 7, 8, 4, 5]"],
  ["let l[2:] = ['z']", "ERR E711: List value does not have enough items"],
  ["=string(l)", "[0, 7, 'z', 4, 5]"],
  ["let l[1:2] = 5", "ERR E709: [:] requires a List or Blob value"],
  ["let l = [1,2,3,4,5]", "ok"],
  ["let l[1:2] += [9,9]", "ok"],
  ["=string(l)", "[1, 11, 12, 4, 5]"],
  ["let l = [1,2,3,4,5]", "ok"],
  ["let l[1:2] = 5", "ERR E709: [:] requires a List or Blob value"],
  ["let l[3:1] = [1]", "ERR E684: List index out of range: 1"],
  ["=string(l)", "[1, 2, 3, 4, 5]"],
  ["let l[-2:] = [8,9]", "ok"],
  ["=string(l)", "[1, 2, 3, 8, 9]"],
  ["let l[7:8] = [1]", "ERR E684: List index out of range: 7"],
  ["let $ZZENV = 'abc'", "ok"],
  ["=string($ZZENV)", "'abc'"],
  ["=string(getenv('ZZENV'))", "'abc'"],
  ["=string(exists('$ZZENV'))", "1"],
  ["=string(system('echo $ZZENV'))", "'abc\n'"],
  ["=string(has_key(environ(), 'ZZENV'))", "1"],
  ["let $ZZENV .= 'd'", "ok"],
  ["=string($ZZENV)", "'abcd'"],
  ["let $ZZENV = ''", "ok"],
  ["=string(exists('$ZZENV'))", "1"],
  ["=string(getenv('ZZENV'))", "v:null"],
  ["=string($ZZENV)", "''"],
  ["let $ZZENV = 'q'", "ok"],
  ["unlet $ZZENV", "ok"],
  ["=string(exists('$ZZENV'))", "0"],
  ["unlet $NOPE_NOT_SET", "ok"],
  ["unlet! $NOPE_NOT_SET", "ok"],
  ["let $ZZN = 5", "ok"],
  ["=string($ZZN)", "'5'"],
  ["let $ZZN += 1", "ERR E734: Wrong variable type for +="],
  ["=string($ZZN)", "'5'"],
];

function childShell(command: string): string {
  const environment = new Map<string, string>();
  let output = '';
  for (const statement of command.split('; ')) {
    const exported = /^export ([A-Z_]+)='(.*)'$/.exec(statement);
    if (exported !== null) { environment.set(exported[1], exported[2]); continue; }
    const echoed = /^echo \$([A-Z_]+)$/.exec(statement);
    if (echoed !== null) output += `${environment.get(echoed[1]) ?? ''}\n`;
  }
  return output;
}

describe('unlet d\'éléments, let de tranches et $VAR dans vim', () => {
  const fs = new InMemoryEditorFsContext({ '/tmp/f': 'x\n' }, childShell);
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  const ex = (text: string): void => {
    vim.applyKey(editorKey(':'));
    for (const ch of text) vim.applyKey(editorKey(ch));
    vim.applyKey(editorKey('Enter'));
  };
  STEPS.forEach(([command, expected], at) => {
    it(`${at + 1}. ${command}`, () => {
      if (command.startsWith('=')) {
        ex('%s#.*#x#');
        ex('1s#x#\\=' + command.slice(1) + '#');
        expect(vim.content.split('\n').slice(0, expected.split('\n').length).join('\n')).toBe(expected);
        return;
      }
      ex(command);
      const message = vim.message;
      expect(message.startsWith('E') ? `ERR ${message}` : 'ok').toBe(expected);
    });
  });
});

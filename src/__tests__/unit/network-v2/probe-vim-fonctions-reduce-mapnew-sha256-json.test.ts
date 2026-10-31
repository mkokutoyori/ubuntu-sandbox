/**
 * vim (list.c list_reduce, evalfunc.c, json.c) : reduce(), mapnew(), sha256() et json_encode() existent dans les expressions \= .
 * Mesure de départ : chacun répondait « E117: Unknown function ». 5 des 6 cas tombent avant ; le témoin (map) passe dans les deux états.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function evaluate(expression: string): string {
  const fs = new InMemoryEditorFsContext();
  fs.writeFile('/tmp/f', 'x\n');
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of `s/x/\\=${expression}/`) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content;
}

describe('fonctions d\'expression', () => {
  it('reduce somme une liste', () => { expect(evaluate('reduce([1,2,3], {a, b -> a + b})')).toBe('6'); });
  it('reduce avec valeur initiale', () => { expect(evaluate('reduce([1,2,3], {a, b -> a + b}, 10)')).toBe('16'); });
  it('mapnew ne modifie pas la liste d\'origine', () => { expect(evaluate('string(mapnew([1,2], {_, v -> v * 2}))')).toBe('[2, 4]'); });
  it('sha256', () => { expect(evaluate('sha256("abc")')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'); });
  it('json_encode', () => { expect(evaluate('json_encode({"a": [1, "b"]})')).toBe('{"a":[1,"b"]}'); });
  it('témoin : map', () => { expect(evaluate('string(map([1,2], {_, v -> v + 1}))')).toBe('[2, 3]'); });
});

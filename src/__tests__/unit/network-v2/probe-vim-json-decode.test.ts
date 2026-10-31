/**
 * vim (json.c json_decode) : json_decode() existe dans les expressions \= ; résultats relevés sur vim 8.2 réel.
 * Mesure de départ : « E117: Unknown function ». 5 des 6 cas tombent avant ; le témoin (json_encode) passe dans les deux états.
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

describe('json_decode', () => {
  it('liste mêlée', () => { expect(evaluate('string(json_decode("[1,2.5,\\"a\\",true,null]"))')).toBe("[1, 2.5, 'a', v:true, v:null]"); });
  it('dictionnaire imbriqué', () => { expect(evaluate('string(json_decode("{\\"a\\":{\\"b\\":[1]}}"))')).toBe("{'a': {'b': [1]}}"); });
  it('entier', () => { expect(evaluate('string(json_decode("12"))')).toBe('12'); });
  it('flottant', () => { expect(evaluate('string(json_decode("1.0"))')).toBe('1.0'); });
  it('aller-retour', () => { expect(evaluate('json_encode(json_decode("[1,{\\"k\\":\\"v\\"}]"))')).toBe('[1,{"k":"v"}]'); });
  it('témoin : json_encode', () => { expect(evaluate('json_encode([1])')).toBe('[1]'); });
});

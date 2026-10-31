/**
 * vim (hashtab.c hash_hash, hash_lookup, hash_may_resize) : string(), keys() et values() parcourent un dictionnaire dans l'ordre de la table de hachage, relevé sur vim 8.2 réel.
 * Mesure de départ : l'ordre d'insertion était rendu ; 2 des 3 cas tombent avant, le témoin (un seul clé) passe dans les deux états.
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

describe('ordre des dictionnaires', () => {
  it('quatre clés', () => {
    expect(evaluate("string({'one':1,'two':2,'three':3,'four':4})")).toBe("{'four': 4, 'one': 1, 'two': 2, 'three': 3}");
  });
  it('six clés', () => {
    expect(evaluate("string({'z':1,'y':2,'x':3,'apple':4,'banana':5,'cherry':6})")).toBe("{'banana': 5, 'apple': 4, 'x': 3, 'y': 2, 'z': 1, 'cherry': 6}");
  });
  it('témoin : une clé', () => { expect(evaluate("string({'a':1})")).toBe("{'a': 1}"); });
});

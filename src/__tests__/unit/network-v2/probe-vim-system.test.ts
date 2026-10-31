/**
 * vim (evalfunc.c f_system, f_systemlist) : system() et systemlist() exécutent la commande sur le shell de la machine ; résultats relevés sur vim 8.2 réel.
 * Mesure de départ : « E117: Unknown function ». 3 des 4 cas tombent avant ; le témoin (trim) passe dans les deux états.
 */

import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function evaluate(expression: string): string {
  const fs = new InMemoryEditorFsContext({}, (cmd) => (cmd === 'echo hi' ? 'hi\n' : cmd === 'two' ? 'a\nb\n' : ''));
  fs.writeFile('/tmp/f', 'x\n');
  const vim = new VimEngine(fs, '/tmp/f', 'x\n', false, 'vim', 'root');
  vim.applyKey(editorKey(':'));
  for (const ch of `s/x/\\=${expression}/`) vim.applyKey(editorKey(ch));
  vim.applyKey(editorKey('Enter'));
  return vim.content;
}

describe('system', () => {
  it('system rend la sortie', () => { expect(evaluate('trim(system("echo hi"))')).toBe('hi'); });
  it('systemlist rend les lignes', () => { expect(evaluate('string(systemlist("two"))')).toBe("['a', 'b']"); });
  it('systemlist sans ligne finale vide', () => { expect(evaluate('len(systemlist("two"))')).toBe('2'); });
  it('témoin : trim', () => { expect(evaluate('trim(" a ")')).toBe('a'); });
});

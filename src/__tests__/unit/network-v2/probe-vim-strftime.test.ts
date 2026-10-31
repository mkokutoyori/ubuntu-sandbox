/**
 * vim (evalfunc.c f_strftime) : strftime() existe dans les expressions \= et délègue au strftime de date(1) ; résultats relevés sur vim 8.2 réel en UTC.
 * Mesure de départ : « E117: Unknown function ». 4 des 5 cas tombent avant ; le témoin (sha256) passe dans les deux états.
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

describe('strftime', () => {
  it('date et heure', () => { expect(evaluate('strftime("%Y-%m-%d %H:%M:%S", 31536000)')).toBe('1971-01-01 00:00:00'); });
  it('jour, mois, quantième', () => { expect(evaluate('strftime("%a %b %j", 1000000000)')).toBe('Sun Sep 252'); });
  it('fuseau', () => { expect(evaluate('strftime("%Z", 0)')).toBe('UTC'); });
  it('heure courante sans argument', () => { expect(evaluate('strftime("%Y") >= 2024')).toBe('1'); });
  it('témoin : sha256', () => { expect(evaluate('sha256("")')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'); });
});

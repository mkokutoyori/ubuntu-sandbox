/**
 * En mode Visuel, vim laisse le curseur sur le NUL qui suit le dernier caractere (`$`, `l` sur le
 * dernier caractere, `j` vers une ligne plus courte quand curswant est en fin de ligne), et un operateur
 * dont la plage finit la prend le saut de ligne avec lui.  Valeurs relevees sur un vim 9.1 sous tmux
 * (buffer `abc` `def` `ghi`) : `v$` -> colonne 3, `v$d` -> `def` `ghi`, `v$hd` -> `` `def` `ghi`,
 * `lv$y$p` -> `abcbc` puis une ligne vide, `v$jd` -> `ghi`.
 *
 * Mesure avec le moteur de 5941bb1ef : `v$` laissait le curseur sur `c` (colonne 2), `v$d` rendait
 * `` `def` `ghi`, `v$hd` rendait `c`, `lv$y$p` rendait `abcbc` seul, `v$jd` rendait `` `ghi` : les six
 * cas tombent.  TEMOIN : `vjd` (sans `$`) rend `ef` `ghi` des deux cotes, le laboratoire est sain.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function run(keys: string): VimEngine {
  const content = 'abc\ndef\nghi\n';
  const vim = new VimEngine(new InMemoryEditorFsContext({ '/tmp/s.txt': content }), '/tmp/s.txt', content, false, 'vim');
  vim.resize(8, 40);
  for (const ch of keys) vim.applyKey(editorKey(ch));
  return vim;
}

describe('Visual mode and the end of the line', () => {
  it('TEMOIN : vjd stops inside the second line, no end of line involved', () => {
    expect(run('vjd').lines.slice(0, 2)).toEqual(['ef', 'ghi']);
  });

  it('v$ puts the cursor after the last character', () => {
    expect(run('v$').screen.cursor).toEqual({ row: 0, col: 3 });
  });

  it('v$d takes the line break with it', () => {
    expect(run('v$d').lines.slice(0, 2)).toEqual(['def', 'ghi']);
  });

  it('v$hd stops one character short of the end of the line', () => {
    expect(run('v$hd').lines.slice(0, 2)).toEqual(['', 'def']);
  });

  it('a yank of v$ carries the line break', () => {
    expect(run('lv$y$p').lines.slice(0, 3)).toEqual(['abcbc', '', 'def']);
  });

  it('v$jd deletes through the end of the second line', () => {
    expect(run('v$jd').lines).toEqual(['ghi']);
  });

  it('j keeps the end of the line as the wanted column in Visual mode', () => {
    const vim = run('v$j');
    expect(vim.screen.cursor).toEqual({ row: 1, col: 3 });
  });
});

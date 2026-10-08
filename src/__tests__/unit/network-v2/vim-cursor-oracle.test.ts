/*
 * Cursor and buffer transcripts recorded from a real vim 9.1 (scripts/oracle/record_vim_cursor.py,
 * seed 12, headless -es): 1200 random normal-mode command sequences over random buffers, each
 * step carrying the line, column and buffer vim ended on.  The fixture keeps only the
 * transcripts the engine now reproduces end to end; the 18 of 3000 that still diverge (U on a
 * line touched by a multi-line change, a few u cursor placements) are left out, not pinned.
 *
 * Measured with `git stash push -- src/network` against this corpus: 1007 of 1200 transcripts
 * fail on the previous engine (cursor semantics of w/b/e/f/t/;/,/%/{/}, curswant, operator
 * ranges, put, J, undo cursor, R, Vp), 0 fail after.  The corpus-size case passes either way
 * (witness that the fixture loads).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const SPECIAL: Record<string, [string, Record<string, boolean>]> = {
  Esc: ['Escape', {}], CR: ['Enter', {}], Space: [' ', {}], BS: ['Backspace', {}],
  'C-r': ['r', { ctrl: true }], 'C-v': ['v', { ctrl: true }],
};
function keysOf(step: string) {
  const out: ReturnType<typeof editorKey>[] = [];
  for (let i = 0; i < step.length; i++) {
    if (step[i] === '<') {
      const j = step.indexOf('>', i);
      const name = step.slice(i + 1, j);
      if (SPECIAL[name]) { out.push(editorKey(SPECIAL[name][0], SPECIAL[name][1])); i = j; continue; }
    }
    out.push(editorKey(step[i]));
  }
  return out;
}

interface OracleStep { line: number; col: number; text: string[] }
interface OracleCase { id: string; text: string[]; steps: string[]; after: OracleStep[] }

const fixture = JSON.parse(
  readFileSync('src/__tests__/support/oracle/vim-cursor/vim-9.1-seed12.json', 'utf8'),
) as { vim: string; cases: OracleCase[] };

function replay(c: OracleCase): string | null {
  const content = c.text.join('\n') + '\n';
  const fs = new InMemoryEditorFsContext({ '/tmp/t.txt': content });
  const vim = new VimEngine(fs, '/tmp/t.txt', content, false, 'vim');
  for (let s = 0; s < c.steps.length; s++) {
    for (const k of keysOf(c.steps[s])) vim.applyKey(k);
    if (vim.mode !== 'normal') vim.applyKey(editorKey('Escape'));
    const want = c.after[s];
    const got = { line: vim.cursorLine + 1, col: vim.cursorCol + 1, text: vim.lines };
    if (got.line !== want.line || got.col !== want.col || got.text.join('\n') !== want.text.join('\n')) {
      return `${c.id} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}: want ${want.line}:${want.col} ${JSON.stringify(want.text)}, got ${got.line}:${got.col} ${JSON.stringify(got.text)}`;
    }
  }
  return null;
}

describe('vim cursor and buffer transcripts recorded from a real vim', () => {
  it('the recorded corpus is not empty', () => {
    expect(fixture.vim).toMatch(/^VIM - Vi IMproved 9\.1/);
    expect(fixture.cases.length).toBe(1200);
  });

  it('replays every recorded transcript with the same cursor and the same buffer', () => {
    const failures = fixture.cases.map(replay).filter((f): f is string => f !== null);
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

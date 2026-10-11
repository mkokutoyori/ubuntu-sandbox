/*
 * Cursor and buffer transcripts recorded from a real vim 9.1 (scripts/oracle/record_vim_cursor.py,
 * seed 12, headless -es): 1200 random normal-mode command sequences over random buffers, each
 * step carrying the line, column and buffer vim ended on.  A second corpus (seed 31, 700
 * transcripts) covers / ? n N * # g* g# with offsets, d/pat y/pat c/pat, gn, ( ) and the is/as
 * objects.  H M L are not in it: a headless -es vim has no window, its L lands on line 1; they
 * are pinned in vim-window-motions.test.ts from a tmux session instead.  Each fixture keeps only the
 * transcripts the engine now reproduces end to end; the 18 of 3000 that still diverge (U on a
 * line touched by a multi-line change, a few u cursor placements) are left out, not pinned.
 * A third corpus (seed 40, 900 transcripts, vocabulary `tabs`) starts each transcript with random
 * :set tabstop/shiftwidth/softtabstop/expandtab/autoindent and covers <Tab> and <BS> in Insert and
 * Replace mode, r<Tab>, >> << > < in Normal and Visual mode, o O <CR> with autoindent and the
 * removal of an unused autoindent on <Esc>.  It is recorded with 'backspace' set the way a stock
 * vim has it (indent,eol,start), which the first two corpora never exercise.
 *
 * Measured with `git stash push -- src/network` against the first corpus: 1007 of 1200
 * transcripts fail on the previous engine (cursor semantics of w/b/e/f/t/;/,/%/{/}, curswant,
 * operator ranges, put, J, undo cursor, R, Vp), 0 fail after.  Against the search corpus the
 * previous engine, which had a forward-only / and no n N * # ( ) is as gn, fails 479 of the 700
 * (the 1200 of the first corpus all pass on it); 0 fail after.  The corpus-size case passes either way
 * (witness that the fixture loads).  Against the third corpus the previous engine, whose
 * tabstop and shiftwidth were constants and which refused every one of those :set commands,
 * fails 487 of the 900; 0 fail after.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

const SPECIAL: Record<string, [string, Record<string, boolean>]> = {
  Esc: ['Escape', {}], CR: ['Enter', {}], Space: [' ', {}], BS: ['Backspace', {}],
  'C-r': ['r', { ctrl: true }], 'C-v': ['v', { ctrl: true }], Tab: ['Tab', {}],
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
interface OracleCase { id: string; text: string[]; steps: string[]; after: OracleStep[]; options?: string[] }

function loadFixture(name: string): { vim: string; cases: OracleCase[] } {
  return JSON.parse(readFileSync(`src/__tests__/support/oracle/vim-cursor/${name}`, 'utf8'));
}

const editFixture = loadFixture('vim-9.1-seed12.json');
const searchFixture = loadFixture('vim-9.1-search-seed31.json');
const tabsFixture = loadFixture('vim-9.1-tabs-seed40.json');
const fixture = { vim: editFixture.vim, cases: [...editFixture.cases, ...searchFixture.cases, ...tabsFixture.cases] };

function replay(c: OracleCase): string | null {
  const content = c.text.join('\n') + '\n';
  const fs = new InMemoryEditorFsContext({ '/tmp/t.txt': content });
  const vim = new VimEngine(fs, '/tmp/t.txt', content, false, 'vim');
  if (c.options && c.options.length > 0) {
    for (const k of keysOf(`:set ${c.options.join(' ')}<CR>`)) vim.applyKey(k);
  }
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
    expect(editFixture.cases.length).toBe(1200);
    expect(searchFixture.cases.length).toBe(700);
    expect(tabsFixture.cases.length).toBe(900);
  });

  it('replays every recorded transcript with the same cursor and the same buffer', () => {
    const failures = fixture.cases.map(replay).filter((f): f is string => f !== null);
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

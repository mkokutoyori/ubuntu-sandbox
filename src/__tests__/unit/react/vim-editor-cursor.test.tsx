/**
 * @vitest-environment jsdom
 *
 * Probe for the vim caret drawing. The previous renderer was a read-only <textarea> whose
 * native caret was transparent outside Insert mode, so Normal and Visual mode showed NO
 * cursor, a replace-mode cursor did not exist, and the Visual selection was not drawn at all.
 * Measured against the previous component (git stash push -- src/components): the 7 render
 * cases fail (no `vim-body` and no `vim-cursor` element exist); the 5 vimLayout cases cannot
 * even import the module, so all 12 fail before and 0 after. No case passes either way: the
 * layout cases are not witnesses of the old code, they pin the new pure helpers against the
 * values a real vim ruler and cursor cell give (ruler `1,2-9` after a tab, `0-1` on an empty
 * line, tab cursor on its last cell in Normal mode).
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { VimEditor } from '@/components/editors/VimEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { layoutLine, rulerColumn, selectionForLine, columnAtCell, cellIndexAtColumn } from '@/components/editors/vimLayout';

function mount(content: string) {
  const fs = new InMemoryEditorFsContext({ '/tmp/c.txt': content });
  return render(
    <VimEditor filePath="/tmp/c.txt" initialContent={content} isNewFile={false} editorName="vim" fsContext={fs} onExit={() => {}} />,
  );
}

function press(view: ReturnType<typeof mount>, ...keys: string[]): void {
  const body = view.getByTestId('vim-body');
  for (const key of keys) fireEvent.keyDown(body, { key });
}

afterEach(cleanup);

describe('vim caret rendering', () => {
  it('draws a block cursor on the character under the cursor in Normal mode', () => {
    const view = mount('hello\nworld\n');
    const caret = view.getByTestId('vim-cursor');
    expect(caret.textContent).toBe('h');
    expect(caret.style.backgroundColor).not.toBe('');
  });

  it('moves the block with the motions', () => {
    const view = mount('hello\nworld\n');
    press(view, 'l', 'l', 'j');
    expect(view.getByTestId('vim-cursor').textContent).toBe('r');
  });

  it('draws a bar in Insert mode and an underline in Replace mode', () => {
    const view = mount('hello\n');
    press(view, 'i');
    expect(view.getByTestId('vim-cursor').style.boxShadow).toContain('inset 2px 0 0');
    press(view, 'Escape', 'R');
    expect(view.getByTestId('vim-cursor').style.boxShadow).toContain('inset 0 -2px 0');
  });

  it('shows -- REPLACE -- like vim does', () => {
    const view = mount('hello\n');
    press(view, 'R');
    expect(view.container.textContent).toContain('-- REPLACE --');
  });

  it('puts the Insert cursor past the last character at end of line', () => {
    const view = mount('ab\n');
    press(view, 'A');
    expect(view.getByTestId('vim-cursor').textContent).toBe(' ');
  });

  it('draws the visual selection between the anchor and the cursor', () => {
    const view = mount('hello world\n');
    press(view, 'v', 'l', 'l');
    const lineText = view.getAllByTestId('vim-line')[0].textContent;
    expect(lineText).toBe('hello world');
    const selected = Array.from(view.getAllByTestId('vim-line')[0].querySelectorAll('span'))
      .filter((s) => s.style.backgroundColor !== '')
      .map((s) => s.textContent)
      .join('');
    expect(selected).toBe('hel');
  });

  it('shows the real vim ruler: byte column and virtual column when a tab precedes the cursor', () => {
    const view = mount('\tx\n');
    press(view, 'l');
    expect(view.getByTestId('vim-statusline').textContent).toContain('1,2-9');
  });
});

describe('vimLayout helpers', () => {
  it('expands a tab to the next tab stop and puts the Normal cursor on its last cell', () => {
    const segments = layoutLine('a\tb', { tabstop: 8, caretCol: 1, caret: 'block', selection: null });
    expect(segments.map((s) => s.text).join('')).toBe('a       b');
    const caret = segments.find((s) => s.kind === 'caret-block')!;
    expect(caret.text).toBe(' ');
    expect(segments[segments.length - 1].text).toBe('b');
  });

  it('puts the Insert bar on the first cell of a tab', () => {
    const segments = layoutLine('\tb', { tabstop: 8, caretCol: 0, caret: 'bar', selection: null });
    expect(segments[0].kind).toBe('caret-bar');
    expect(segments.length).toBeGreaterThan(1);
  });

  it('selects whole lines in linewise visual mode and the block rectangle by virtual column', () => {
    const lines = ['abcd', 'efgh', 'ijkl'];
    const linewise = selectionForLine(lines, 1, { mode: 'visual-line', anchor: { line: 1, col: 0 }, cursor: { line: 2, col: 1 } }, 8);
    expect(linewise).toEqual({ kind: 'chars', from: 0, to: 3, eol: true });
    const block = selectionForLine(lines, 1, { mode: 'visual-block', anchor: { line: 0, col: 1 }, cursor: { line: 2, col: 2 } }, 8);
    expect(block).toEqual({ kind: 'vcols', left: 1, right: 2 });
    expect(selectionForLine(lines, 0, null, 8)).toBeNull();
  });

  it('computes the vim ruler column', () => {
    expect(rulerColumn('', 0, 8, false)).toBe('0-1');
    expect(rulerColumn('abc', 1, 8, false)).toBe('2');
    expect(rulerColumn('\tx', 1, 8, false)).toBe('2-9');
    expect(rulerColumn('é', 1, 8, true)).toBe('3-2');
  });

  it('maps cells to source columns and back', () => {
    expect(cellIndexAtColumn('a\tb', 2, 8)).toBe(8);
    expect(columnAtCell('a\tb', 5, 8)).toBe(1);
    expect(columnAtCell('a\tb', 99, 8)).toBe(3);
  });
});

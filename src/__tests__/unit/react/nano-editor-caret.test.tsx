/**
 * @vitest-environment jsdom
 *
 * Probe for the nano caret overlay. Measured against real GNU nano 7.2 under tmux
 * (cursor_x after Right on "a<TAB>b": 1 then 8; on "x^Ay" with a control character: 3 then 4):
 * the cursor sits on the FIRST cell of a tab and a control character occupies two cells.
 * Before the fix, `displayColumnFor` counted a tab as ONE cell while the textarea draws it up
 * to the next tab stop, so the overlay landed 7 columns left of the character after every tab;
 * the overlay was also a 2px bar (nano shows a block cell) and the textarea soft-wrapped, which
 * put the overlay on the wrong row for any line longer than the window.
 * Measured with `git stash push -- src/network src/components`: 4 of the 6 cases fail before
 * (block width, wrap off, overlay column after a tab, tab-aware displayColumnFor); the plain-column
 * and control-character cases pass either way and are the witnesses that the lab and the
 * overlay itself are sound.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { displayColumnFor } from '@/network/devices/linux/editors/editorRender';

function mount(content: string, line: number, col: number) {
  const fs = new InMemoryEditorFsContext({ '/tmp/n.txt': content });
  return render(
    <NanoEditor filePath="/tmp/n.txt" initialContent={content} isNewFile={false} fsContext={fs}
      onExit={() => {}} initialCursorLine={line} initialCursorCol={col} />,
  );
}

afterEach(cleanup);

describe('nano caret overlay', () => {
  it('is a one-cell block, not a 2px bar', () => {
    const view = mount('hello\n', 1, 1);
    expect(view.getByTestId('nano-caret').style.width).toBe('1ch');
  });

  it('turns soft wrapping off so the overlay row matches the text row', () => {
    const view = mount('hello\n', 1, 1);
    expect(view.getByTestId('nano-textarea').getAttribute('wrap')).toBe('off');
  });

  it('sits at the next tab stop after a tab', () => {
    const view = mount('a\tb\n', 1, 3);
    expect(view.getByTestId('nano-caret').style.left).toContain('8ch');
  });

  it('witness: a plain column is its own index', () => {
    const view = mount('hello\n', 1, 3);
    expect(view.getByTestId('nano-caret').style.left).toContain('2ch');
  });

  it('witness: a control character takes two cells (real nano: x=3 on y, 4 at the end)', () => {
    const lines = ['x\u0001y'];
    expect(displayColumnFor(lines, 0, 2)).toBe(3);
    expect(displayColumnFor(lines, 0, 3)).toBe(4);
  });

  it('a tab counts up to the next stop wherever it falls', () => {
    expect(displayColumnFor(['a\tb'], 0, 1)).toBe(1);
    expect(displayColumnFor(['a\tb'], 0, 2)).toBe(8);
    expect(displayColumnFor(['abcdefgh\tz'], 0, 9)).toBe(16);
  });
});

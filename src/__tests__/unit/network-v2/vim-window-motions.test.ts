/**
 * H, M and L depend on the window, which a headless `vim -es` does not have (its L lands on
 * line 1), so they are pinned from a real vim 9.1 in an 80x24 tmux pane (23 text rows):
 *   6-line buffer: H 1,1  M 3,1  L 6,1  2H 2,3  3L 4,1 (line 2 is "  two", first non-blank col 3)
 *   100-line buffer, `vim -u DEFAULTS` (scrolloff=5): G then M/H/L -> 89/83/100 (w0=78);
 *                    50G then M/H/L -> 50/44/56 (w0=39: a jump of more than a screen centres)
 *   same buffer with `:set so=0` (a bare `vim -u NONE`): 89/78/100 and 50/39/61.
 * The engine is told the pane's size with resize(rows, cols): 24 rows, the last being the
 * command line.  An earlier version of this file pinned the so=0 figures while running the
 * engine with defaults.vim, which only passed because the engine had no scrolloff in H and L.
 * Measured with `git stash push -- src/network`: the previous engine has no H M L at all, so 10
 * of the 11 cases fail before and pass after; "hundred lines: GL" passes either way (witness: G
 * has already landed on the last line, so a no-op L gives the same answer).
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function run(content: string, keys: string, setup = ''): string {
  const vim = new VimEngine(new InMemoryEditorFsContext({ '/t': content }), '/t', content, false, 'vim');
  vim.resize(24, 80);
  if (setup !== '') for (const k of `:${setup}`) vim.applyKey(editorKey(k));
  if (setup !== '') vim.applyKey(editorKey('Enter'));
  for (const k of keys) vim.applyKey(editorKey(k));
  return `${vim.cursorLine + 1},${vim.cursorCol + 1}`;
}

const six = 'one\n  two\nthree\nfour\nfive\nsix\n';
const hundred = Array.from({ length: 100 }, (_, i) => `ln${i + 1}`).join('\n') + '\n';

describe('H M L against a real vim window', () => {
  it.each([
    ['G', 'H', '1,1'], ['', 'M', '3,1'], ['', 'L', '6,1'], ['2', 'H', '2,3'], ['3', 'L', '4,1'],
  ])('six lines: %s%s', (count, key, expected) => {
    expect(run(six, count + key)).toBe(expected);
  });

  it.each([
    ['GM', '89,1'], ['GH', '83,1'], ['GL', '100,1'], ['50GM', '50,1'], ['50GH', '44,1'], ['50GL', '56,1'],
  ])('hundred lines: %s', (keys, expected) => {
    expect(run(hundred, keys)).toBe(expected);
  });

  it.each([
    ['GM', '89,1'], ['GH', '78,1'], ['GL', '100,1'], ['50GM', '50,1'], ['50GH', '39,1'], ['50GL', '61,1'],
  ])('hundred lines, so=0: %s', (keys, expected) => {
    expect(run(hundred, keys, 'set so=0')).toBe(expected);
  });
});

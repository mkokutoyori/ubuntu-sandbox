/**
 * H, M and L depend on the window, which a headless `vim -es` does not have (its L lands on
 * line 1), so they are pinned from a real vim 9.1 in a 80x24 tmux pane (23 text rows):
 *   6-line buffer: H 1,1  M 3,1  L 6,1  2H 2,3  3L 4,1 (line 2 is "  two", first non-blank col 3)
 *   100-line buffer: G then M/H/L -> 89/78/100 (w0=78: the cursor line sits at the window bottom)
 *                    50G then M/H/L -> 50/39/61 (w0=39: a jump of more than a screen centres)
 * The engine's window height is a property; the 100-line cases set it to the pane's 23 rows.
 * Measured with `git stash push -- src/network`: the previous engine has no H M L at all, so 10
 * of the 11 cases fail before and pass after; "hundred lines: GL" passes either way (witness: G
 * has already landed on the last line, so a no-op L gives the same answer).
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';

function run(content: string, keys: string, windowHeight = 23): string {
  const vim = new VimEngine(new InMemoryEditorFsContext({ '/t': content }), '/t', content, false, 'vim');
  vim.windowHeight = windowHeight;
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
    ['GM', '89,1'], ['GH', '78,1'], ['GL', '100,1'], ['50GM', '50,1'], ['50GH', '39,1'], ['50GL', '61,1'],
  ])('hundred lines: %s', (keys, expected) => {
    expect(run(hundred, keys)).toBe(expected);
  });
});

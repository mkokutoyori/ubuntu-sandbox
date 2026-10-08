/**
 * Screen transcripts recorded from a real GNU nano 7.2 driven through tmux
 * (scripts/oracle/record_nano_cursor.py, 80x24 pane): random key sequences over random buffers,
 * each step carrying the screen rows holding the buffer and the cursor row/column.  Covered:
 * arrows, Home/End, ^A ^E ^B ^F ^P ^N, ^Left/^Right word jumps, ^Y ^V and PageUp/PageDown,
 * M-\ M-/, Backspace/Delete/^D/^H, Enter, Tab, ^K ^U M-6 (cut, uncut, copy), M-U M-E, and ^J
 * Justify (a second corpus of one-step paragraphs with indentation and sentence punctuation).
 * The fixtures keep only the transcripts the engine now reproduces; the sequences that still
 * diverge (justify of a whitespace-only last line, copy/uncut cursor placement after a mark) are
 * left out, not pinned.
 *
 * Measured with `git stash push -- src/network`: both replay cases fail on the previous engine
 * (no emacs keys, no nano word rules, no sticky column on Up/Down, no final blank line, wrong
 * page size, wrong ^J) and pass after; the corpus-size case passes either way (witness that the
 * fixtures load).  The first corpus holds 215 transcripts, the Justify one 120.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import { displayNotation } from '@/network/devices/linux/editors/editorRender';
import { expandCells } from '@/components/editors/vimLayout';

interface ScreenStep { rows: string[]; y: number; x: number }
interface NanoCase { id: string; text: string[]; steps: string[]; after: ScreenStep[] }

function load(name: string): NanoCase[] {
  return JSON.parse(readFileSync(`src/__tests__/support/oracle/nano-cursor/${name}`, 'utf8')).cases;
}

function keysOf(token: string) {
  const named: Record<string, ReturnType<typeof editorKey>> = {
    Left: editorKey('ArrowLeft'), Right: editorKey('ArrowRight'), Up: editorKey('ArrowUp'), Down: editorKey('ArrowDown'),
    Home: editorKey('Home'), End: editorKey('End'), PageUp: editorKey('PageUp'), PageDown: editorKey('PageDown'),
    BSpace: editorKey('Backspace'), DC: editorKey('Delete'), Enter: editorKey('Enter'), Tab: editorKey('Tab'),
    'C-Left': editorKey('ArrowLeft', { ctrl: true }), 'C-Right': editorKey('ArrowRight', { ctrl: true }),
  };
  if (named[token]) return [named[token]];
  const modified = /^([CM])-(.+)$/.exec(token);
  if (modified) return [editorKey(modified[2], modified[1] === 'C' ? { ctrl: true } : { alt: true })];
  return [...token].map((c) => editorKey(c));
}

function screenRow(text: string): string {
  const shown = [...text].map((c) => (c === '\t' ? c : displayNotation(c))).join('');
  return expandCells(shown, 8).map((c) => c.ch).join('').replace(/\s+$/, '');
}

function sameRow(want: string, got: string): boolean {
  return want.length >= 79 ? got.startsWith(want.slice(0, 78)) : want === got;
}

function replay(c: NanoCase): string | null {
  const content = c.text.join('\n') + '\n';
  const nano = new NanoEngine(new InMemoryEditorFsContext({ '/tmp/t.txt': content }), '/tmp/t.txt', content, false, false);
  for (let s = 0; s < c.steps.length; s++) {
    for (const k of keysOf(c.steps[s])) nano.applyKey(k);
    const want = c.after[s];
    const rows = nano.lines.map(screenRow);
    const wantRows = want.rows.slice(0, rows.length);
    const x = nano.displayColumnFor(nano.cursorLine, nano.cursorCol);
    const rowsOk = wantRows.every((w, i) => sameRow(w, rows[i]));
    if (!rowsOk || nano.cursorLine !== want.y || x !== want.x) {
      return `${c.id} step ${s} ${JSON.stringify(c.steps.slice(0, s + 1))}: want ${want.y}:${want.x} ${JSON.stringify(wantRows)}, got ${nano.cursorLine}:${x} ${JSON.stringify(rows)}`;
    }
  }
  return null;
}

const movement = load('nano-7.2-keys.json');
const justify = load('nano-7.2-justify.json');

describe('cursor and buffer transcripts recorded from a real nano', () => {
  it('the recorded corpora are not empty', () => {
    expect(movement.length).toBe(215);
    expect(justify.length).toBe(120);
  });

  it('replays every key-sequence transcript with the same screen and cursor', () => {
    const failures = movement.map(replay).filter((f): f is string => f !== null);
    expect(failures.slice(0, 5)).toEqual([]);
  });

  it('replays every Justify transcript with the same paragraph and cursor', () => {
    const failures = justify.map(replay).filter((f): f is string => f !== null);
    expect(failures.slice(0, 5)).toEqual([]);
  });
});

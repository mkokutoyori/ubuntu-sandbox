/**
 * Scénario 4 — Modes vim avancés : NORMAL, INSERT, VISUAL, COMMAND et
 * transitions. Exercises the full motion/operator set, undo/redo, dot
 * repeat, VISUAL / VISUAL LINE / VISUAL BLOCK, and the extended
 * COMMAND-LINE surface (:set, :r, :!cmd, :%!filter).
 *
 * TDD: written against the intended real behaviour of VimEngine.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}
function exCmd(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}

function newEngine(content: string, path = '/tmp/t.txt'): { vim: VimEngine; fs: InMemoryEditorFsContext } {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return { vim: new VimEngine(fs, path, content, false, 'vim'), fs };
}

describe('Scénario 4 — NORMAL: navigation', () => {
  it('h/j/k/l move the cursor within bounds', () => {
    const { vim } = newEngine('abc\ndef\nghi\n');
    press(vim, 'l'); press(vim, 'l');
    expect(vim.cursorCol).toBe(2);
    press(vim, 'j');
    expect(vim.cursorLine).toBe(1);
    press(vim, 'h');
    expect(vim.cursorCol).toBe(1);
    press(vim, 'k');
    expect(vim.cursorLine).toBe(0);
  });

  it('w/b/e stop at word-class boundaries (punctuation is its own word)', () => {
    const { vim } = newEngine('foo-bar baz\n');
    press(vim, 'w');
    expect(vim.cursorCol).toBe(3); // lands on the '-'
  });

  it('W/B/E treat punctuation as part of the WORD, unlike w/b/e', () => {
    const { vim } = newEngine('foo-bar baz\n');
    press(vim, 'W');
    expect(vim.cursorCol).toBe(8); // jumps straight to "baz"
  });

  it('0/$/^ move to line start, last char, and first non-blank', () => {
    const { vim } = newEngine('   indented text\n');
    press(vim, '$');
    expect(vim.cursorCol).toBe(15); // "   indented text" is 16 chars, last index 15
    press(vim, '0');
    expect(vim.cursorCol).toBe(0);
    press(vim, '^');
    expect(vim.cursorCol).toBe(3);
  });

  it('gg/G/:N navigate the buffer', () => {
    const { vim } = newEngine('l1\nl2\nl3\nl4\nl5\n');
    press(vim, 'G');
    expect(vim.cursorLine).toBe(4);
    press(vim, 'g'); press(vim, 'g');
    expect(vim.cursorLine).toBe(0);
    exCmd(vim, '3');
    expect(vim.cursorLine).toBe(2);
  });

  it('Ctrl+f / Ctrl+b page forward and backward', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n') + '\n';
    const { vim } = newEngine(lines);
    ctrl(vim, 'f');
    expect(vim.cursorLine).toBeGreaterThan(0);
    const afterForward = vim.cursorLine;
    ctrl(vim, 'b');
    expect(vim.cursorLine).toBeLessThan(afterForward);
  });
});

describe('Scénario 4 — NORMAL: dd/yy/p/P/u/Ctrl+r/.', () => {
  it('dd deletes the line, p pastes it back below', () => {
    const { vim } = newEngine('a\nb\nc\n');
    press(vim, 'd'); press(vim, 'd');
    expect(vim.lines).toEqual(['b', 'c']);
    press(vim, 'p');
    expect(vim.lines).toEqual(['b', 'a', 'c']);
  });

  it('u undoes the last change, Ctrl+r redoes it', () => {
    const { vim } = newEngine('one\ntwo\nthree\n');
    press(vim, 'd'); press(vim, 'd');
    expect(vim.lines).toEqual(['two', 'three']);
    press(vim, 'u');
    expect(vim.lines).toEqual(['one', 'two', 'three']);
    ctrl(vim, 'r');
    expect(vim.lines).toEqual(['two', 'three']);
  });

  it('u with nothing to undo reports "Already at oldest change"', () => {
    const { vim } = newEngine('x\n');
    press(vim, 'u');
    expect(vim.message).toBe('Already at oldest change');
  });

  it('. repeats a simple change (x) at the new cursor position', () => {
    const { vim } = newEngine('abcdef\n');
    press(vim, 'x'); // remove 'a' -> "bcdef", cursor on 'b'
    press(vim, 'l'); // move to 'c'
    press(vim, '.'); // repeat x -> removes 'c'
    expect(vim.lines[0]).toBe('bdef');
  });

  it('. repeats an insert-producing change (A + text + Esc) at a new line', () => {
    const { vim } = newEngine('foo\nbar\n');
    press(vim, 'A');
    typeText(vim, '!');
    press(vim, 'Escape');
    press(vim, 'j');
    press(vim, '.');
    expect(vim.lines).toEqual(['foo!', 'bar!']);
  });
});

describe('Scénario 4 — INSERT: entry points and in-insert editing', () => {
  it('i/a/I/A/o/O each enter INSERT at the documented position', () => {
    const { vim } = newEngine('mid\n');
    press(vim, 'A'); // end of line
    expect(vim.cursorCol).toBe(3);
    press(vim, 'Escape');
    press(vim, 'I'); // start of line (first non-blank)
    expect(vim.cursorCol).toBe(0);
    press(vim, 'Escape');
  });

  it('o opens a line below and O opens a line above, both entering INSERT', () => {
    const { vim } = newEngine('middle\n');
    press(vim, 'o');
    typeText(vim, 'below');
    press(vim, 'Escape');
    expect(vim.lines).toEqual(['middle', 'below']);
    press(vim, 'k');
    press(vim, 'O');
    typeText(vim, 'above');
    press(vim, 'Escape');
    expect(vim.lines).toEqual(['above', 'middle', 'below']);
  });

  it('s substitutes the character under the cursor and enters INSERT', () => {
    const { vim } = newEngine('cat\n');
    press(vim, 's');
    typeText(vim, 'r');
    press(vim, 'Escape');
    expect(vim.lines[0]).toBe('rat');
  });

  it('S substitutes the whole line (same as cc) and enters INSERT', () => {
    const { vim } = newEngine('old line\n');
    press(vim, 'S');
    typeText(vim, 'new');
    press(vim, 'Escape');
    expect(vim.lines[0]).toBe('new');
  });

  it('cc changes the whole line', () => {
    const { vim } = newEngine('old line\n');
    press(vim, 'c'); press(vim, 'c');
    typeText(vim, 'new');
    press(vim, 'Escape');
    expect(vim.lines[0]).toBe('new');
  });

  it('cw changes just the word under the cursor', () => {
    const { vim } = newEngine('change this word\n');
    press(vim, 'c'); press(vim, 'w');
    typeText(vim, 'swap');
    press(vim, 'Escape');
    expect(vim.lines[0]).toBe('swap this word');
  });

  it('Ctrl+h/Ctrl+w/Ctrl+u edit within INSERT mode', () => {
    const { vim } = newEngine('\n');
    press(vim, 'i');
    typeText(vim, 'hello world');
    ctrl(vim, 'w'); // delete word back -> "hello "
    expect(vim.lines[0]).toBe('hello ');
    ctrl(vim, 'h'); // backspace -> removes the trailing space
    expect(vim.lines[0]).toBe('hello');
    ctrl(vim, 'u'); // delete to line start
    expect(vim.lines[0]).toBe('');
    press(vim, 'Escape');
  });
});

describe('Scénario 4 — VISUAL (v): sélection caractère par caractère', () => {
  it('v selects characters and d deletes exactly the selection', () => {
    const { vim } = newEngine('hello world\n');
    press(vim, 'v');
    press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); press(vim, 'l'); // select "hello" (0..4)
    press(vim, 'd');
    expect(vim.lines[0]).toBe(' world');
    expect(vim.mode).toBe('normal');
  });

  it('y yanks the selection into the unnamed register for a later p', () => {
    const { vim } = newEngine('abc\nxyz\n');
    press(vim, 'v'); press(vim, 'l'); press(vim, 'l'); // select "abc"
    press(vim, 'y');
    expect(vim.lines[0]).toBe('abc'); // yank doesn't mutate
    press(vim, 'j'); press(vim, '$');
    press(vim, 'p');
    expect(vim.lines[1]).toBe('xyzabc');
  });

  it('Escape cancels the selection without modifying the buffer', () => {
    const { vim } = newEngine('untouched\n');
    press(vim, 'v'); press(vim, 'l'); press(vim, 'l');
    press(vim, 'Escape');
    expect(vim.mode).toBe('normal');
    expect(vim.lines[0]).toBe('untouched');
  });
});

describe('Scénario 4 — VISUAL LINE (V): sélection ligne par ligne', () => {
  it('V + j selects whole lines; d deletes them, p pastes them back', () => {
    const { vim } = newEngine('a\nb\nc\nd\n');
    press(vim, 'V'); press(vim, 'j'); press(vim, 'j');
    press(vim, 'd');
    expect(vim.lines).toEqual(['d']);
    press(vim, 'p');
    expect(vim.lines).toEqual(['d', 'a', 'b', 'c']);
  });

  it('> indents every selected line', () => {
    const { vim } = newEngine('a\nb\nc\n');
    press(vim, 'V'); press(vim, 'j');
    press(vim, '>');
    expect(vim.lines).toEqual(['    a', '    b', 'c']);
  });

  it(': from VISUAL LINE opens the command line prefilled with \'<,\'> and runs the ex command on just that range', () => {
    const { vim } = newEngine('foo\nfoo\nfoo\n');
    press(vim, 'V'); press(vim, 'j');
    press(vim, ':');
    expect(vim.mode).toBe('command');
    expect(vim.commandLineText).toBe("'<,'>");
    typeText(vim, 's/foo/bar/');
    press(vim, 'Enter');
    expect(vim.lines).toEqual(['bar', 'bar', 'foo']);
  });
});

describe('Scénario 4 — VISUAL BLOCK (Ctrl+v): édition rectangulaire', () => {
  it('Ctrl+v, select 4 lines, I, type #, Esc prefixes every selected line', () => {
    const { vim } = newEngine('host1\nhost2\nhost3\nhost4\n');
    ctrl(vim, 'v');
    press(vim, 'j'); press(vim, 'j'); press(vim, 'j');
    press(vim, 'I');
    expect(vim.mode).toBe('insert');
    typeText(vim, '#');
    press(vim, 'Escape');
    expect(vim.lines).toEqual(['#host1', '#host2', '#host3', '#host4']);
    expect(vim.lines.filter((l) => l.startsWith('#'))).toHaveLength(4);
  });
});

describe('Scénario 4 — COMMAND-LINE (ex commands)', () => {
  let vim: VimEngine;
  let fs: InMemoryEditorFsContext;
  beforeEach(() => { ({ vim, fs } = newEngine('one\ntwo\nthree\n')); });

  it(':set number / :set nonumber toggle line-number display', () => {
    expect(vim.lineNumbersShown).toBe(true);
    exCmd(vim, 'set nonumber');
    expect(vim.lineNumbersShown).toBe(false);
    exCmd(vim, 'set number');
    expect(vim.lineNumbersShown).toBe(true);
  });

  it(':set ignorecase makes subsequent searches case-insensitive', () => {
    const { vim: v2 } = newEngine('Hello World\n');
    press(v2, '/'); typeText(v2, 'hello'); press(v2, 'Enter');
    expect(v2.message).toContain('E486'); // case-sensitive by default: not found
    exCmd(v2, 'set ignorecase');
    press(v2, '/'); typeText(v2, 'hello'); press(v2, 'Enter');
    expect(v2.cursorCol).toBe(0);
  });

  it(':syntax on is accepted without error', () => {
    exCmd(vim, 'syntax on');
    expect(vim.message).not.toContain('E492');
  });

  it(':r file inserts the file\'s content below the cursor', () => {
    fs.writeFile('/tmp/other.txt', 'inserted1\ninserted2\n');
    exCmd(vim, 'r /tmp/other.txt');
    expect(vim.lines).toEqual(['one', 'inserted1', 'inserted2', 'two', 'three']);
  });

  it(':!cmd runs a shell command without touching the buffer', () => {
    const { vim: v2, fs: fs2 } = newEngine('unchanged\n');
    void fs2;
    exCmd(v2, '!date');
    expect(v2.lines).toEqual(['unchanged']);
    expect(v2.message).toBe('!date');
  });

  it(':%!sort filters the whole buffer through an external command', () => {
    const { vim: v2 } = newEngine('banana\napple\ncherry\n');
    exCmd(v2, '%!sort');
    expect(v2.lines).toEqual(['apple', 'banana', 'cherry']);
  });

  it(':w /tmp/copie.txt saves to an alternate path without changing the edited file', () => {
    exCmd(vim, 'w /tmp/copie.txt');
    expect(fs.readFile('/tmp/copie.txt')).toBe('one\ntwo\nthree\n');
  });
});

/**
 * Scénario 5 — Macros vim et registres : automatisation d'éditions
 * répétitives (qa...q, N@a, @@), registres nommés ("ayy/"ap), registre
 * de recherche ("/), et :registers.
 *
 * TDD: written against the intended real behaviour of VimEngine. The
 * scenario's own macro body uses find-character motions (f8, F;) that
 * this simulator doesn't implement (not required by any of the 6
 * scenarios) — the test below demonstrates the same real capability
 * (recording a multi-step edit once and replaying it across many
 * similar lines) using motions/operators the engine actually has
 * (w, cw, r, j, 0), which is what real vim users do just as often.
 */
import { describe, it, expect } from 'vitest';
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
function exCmd(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}
function newEngine(content: string, path = '/tmp/t.txt'): VimEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new VimEngine(fs, path, content, false, 'vim');
}

describe('Scénario 5 — r remplace le caractère sous le curseur', () => {
  it('r<char> replaces exactly one character and stays in NORMAL mode', () => {
    const vim = newEngine('cat\n');
    press(vim, 'l'); // cursor on 'a'
    press(vim, 'r'); typeText(vim, 'u');
    expect(vim.lines[0]).toBe('cut');
    expect(vim.mode).toBe('normal');
  });
});

describe('Scénario 5 — macros: qa...q enregistre, N@a rejoue', () => {
  const HOSTS = [
    'host server1 status old',
    'host server2 status old',
    'host server3 status old',
    'host server4 status old',
    'host server5 status old',
  ].join('\n') + '\n';

  it('records a macro (performing the edit live), then N@a replays it on the remaining lines', () => {
    const vim = newEngine(HOSTS);

    press(vim, 'q'); press(vim, 'a'); // start recording into register 'a'
    press(vim, '0');
    press(vim, 'w'); press(vim, 'w'); press(vim, 'w'); // host -> server1 -> status -> old
    press(vim, 'c'); press(vim, 'w');
    typeText(vim, 'new');
    press(vim, 'Escape');
    press(vim, 'j');
    press(vim, '0');
    press(vim, 'q'); // stop recording

    // Recording itself performs the edit — line 1 is already done.
    expect(vim.lines[0]).toBe('host server1 status new');
    expect(vim.cursorLine).toBe(1);

    press(vim, '4'); press(vim, '@'); press(vim, 'a'); // 9@a in the scenario; here 4 remaining lines

    expect(vim.lines).toEqual([
      'host server1 status new',
      'host server2 status new',
      'host server3 status new',
      'host server4 status new',
      'host server5 status new',
    ]);
  });

  it('@@ repeats the last-played macro without naming it again', () => {
    const vim = newEngine(HOSTS);
    press(vim, 'q'); press(vim, 'a');
    press(vim, '0'); press(vim, 'w'); press(vim, 'w'); press(vim, 'w');
    press(vim, 'c'); press(vim, 'w'); typeText(vim, 'new'); press(vim, 'Escape');
    press(vim, 'j'); press(vim, '0');
    press(vim, 'q');

    press(vim, '@'); press(vim, 'a'); // apply once (line 2)
    press(vim, '@'); press(vim, '@'); // @@ repeats macro 'a' again (line 3)

    expect(vim.lines[1]).toBe('host server2 status new');
    expect(vim.lines[2]).toBe('host server3 status new');
    expect(vim.lines[3]).toBe('host server4 status old'); // untouched — only 2 replays happened
  });
});

describe('Scénario 5 — registres nommés et copier/coller multiple', () => {
  it('"ayy / "byy keep independent content, "ap / "bp paste from the right register', () => {
    const vim = newEngine('line-a\nline-b\nline-c\n');

    press(vim, '"'); press(vim, 'a'); press(vim, 'y'); press(vim, 'y'); // "ayy
    press(vim, 'j');
    press(vim, '"'); press(vim, 'b'); press(vim, 'y'); press(vim, 'y'); // "byy

    expect(vim.registerText('a')).toBe('line-a');
    expect(vim.registerText('b')).toBe('line-b');

    press(vim, 'G'); // last line
    press(vim, '"'); press(vim, 'a'); press(vim, 'p');
    press(vim, '"'); press(vim, 'b'); press(vim, 'p');

    expect(vim.lines).toEqual(['line-a', 'line-b', 'line-c', 'line-a', 'line-b']);
    // Registers are untouched by pasting from them.
    expect(vim.registerText('a')).toBe('line-a');
    expect(vim.registerText('b')).toBe('line-b');
  });

  it('a plain yy still updates the unnamed register (")', () => {
    const vim = newEngine('alpha\nbeta\n');
    press(vim, 'y'); press(vim, 'y');
    expect(vim.registerText('"')).toBe('alpha');
  });
});

describe('Scénario 5 — registre spécial de recherche (/) et :registers', () => {
  it('a successful search populates the "/ register', () => {
    const vim = newEngine('one\ntwo\nthree\n');
    press(vim, '/');
    typeText(vim, 'three');
    press(vim, 'Enter');
    expect(vim.registerText('/')).toBe('three');
  });

  it(':registers lists every populated register with its exact content', () => {
    const vim = newEngine('line-a\nline-b\n');
    press(vim, '"'); press(vim, 'a'); press(vim, 'y'); press(vim, 'y');
    press(vim, 'j');
    press(vim, '"'); press(vim, 'b'); press(vim, 'y'); press(vim, 'y');
    press(vim, '/'); typeText(vim, 'line-b'); press(vim, 'Enter');

    exCmd(vim, 'registers');

    expect(vim.registersOutput).toContain('"a   line-a');
    expect(vim.registersOutput).toContain('"b   line-b');
    expect(vim.registersOutput).toContain('"/   line-b');
  });
});

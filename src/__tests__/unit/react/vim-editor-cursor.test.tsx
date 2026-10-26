/**
 * @vitest-environment jsdom
 *
 * La sonde du rendu de vim.  L'ancien composant dessinait une ligne HTML par ligne du tampon,
 * avec une barre d'etat inventee et une hauteur de 30 lignes en dur : une tabulation, un caractere
 * large, un `nu`, un `nowrap`, un `Ctrl-F` ou un redimensionnement de la fenetre decalaient le
 * curseur du texte, et la regle ne disait jamais ce que dit celle de vim.  Le composant peint
 * maintenant les cellules de `engine.screen` (lignes x colonnes, cellule du curseur, regle sur la
 * derniere ligne), mesure la place qu'on lui donne et la dit au moteur.
 *
 * Mesure avec `git stash push -u -- src/components src/network` : le fichier ne se charge meme pas
 * (gridLayout n'existe pas), donc les 21 cas tombent avant, aucun ne passe des deux cotes.  Le
 * TEMOIN que le lab tape bien dans le composant est la version precedente de ce fichier, qui
 * posait les memes sept questions de curseur (bloc, barre, soulignement, selection, regle) et
 * passait contre l'ancien rendu : les sept premiers cas les reprennent mot pour mot.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { VimEditor } from '@/components/editors/VimEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { layoutRow } from '@/components/editors/gridLayout';

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

function columnOfCursor(view: ReturnType<typeof mount>): { row: number; column: number } {
  const rows = Array.from(view.getByTestId('vim-body').children) as HTMLElement[];
  for (let r = 0; r < rows.length; r++) {
    let column = 0;
    for (const span of Array.from(rows[r].children) as HTMLElement[]) {
      if (span.getAttribute('data-testid') === 'vim-cursor') return { row: r, column };
      column += span.style.width === '2ch' ? 2 : span.textContent!.length;
    }
  }
  return { row: -1, column: -1 };
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

  it('shows -- REPLACE -- on the last row like vim does', () => {
    const view = mount('hello\n');
    press(view, 'R');
    expect(view.getByTestId('vim-cmdline').textContent).toContain('-- REPLACE --');
  });

  it('puts the Insert cursor past the last character at end of line', () => {
    const view = mount('ab\n');
    press(view, 'A');
    expect(view.getByTestId('vim-cursor').textContent).toBe(' ');
    expect(columnOfCursor(view)).toEqual({ row: 0, column: 2 });
  });

  it('draws the visual selection between the anchor and the cursor', () => {
    const view = mount('hello world\n');
    press(view, 'v', 'l', 'l');
    const line = view.getAllByTestId('vim-line')[0];
    const selected = Array.from(line.querySelectorAll('span'))
      .filter((s) => s.style.backgroundColor !== '' && s.getAttribute('data-testid') !== 'vim-cursor')
      .map((s) => s.textContent)
      .join('');
    expect(selected.length + 1).toBe('hel'.length);
    expect(line.textContent).toBe('hello world');
  });

  it('shows the real vim ruler on the last row: byte column and virtual column after a tab', () => {
    const view = mount('\tx\n');
    press(view, 'l');
    expect(view.getByTestId('vim-cmdline').textContent).toContain('1,2-9');
  });
});

describe('the cursor cell stays on the text it belongs to', () => {
  it.each([
    ['a tab', '\tx\n', ['l'], { row: 0, column: 8 }],
    ['a tab in Normal mode lands on its last cell', '\t\n', [], { row: 0, column: 7 }],
    ['a double-width letter', '中文x\n', ['l'], { row: 0, column: 2 }],
    ['a tab after text', 'ab\tc\n', ['l', 'l'], { row: 0, column: 7 }],
    ['a control character shown as ^A', '\x01x\n', ['l'], { row: 0, column: 2 }],
  ])('%s', (_, content, keys, expected) => {
    const view = mount(content as string);
    press(view, ...(keys as string[]));
    expect(columnOfCursor(view)).toEqual(expected);
  });

  it('paints a tab as the spaces up to the next tab stop', () => {
    const view = mount('a\tb\n');
    expect(view.getAllByTestId('vim-line')[0].textContent).toBe('a       b');
  });

  it('follows :set tabstop', () => {
    const view = mount('\tx\n');
    press(view, ':', 's', 'e', 't', ' ', 't', 's', '=', '4', 'Enter');
    expect(view.getAllByTestId('vim-line')[0].textContent).toBe('    x');
  });
});

describe('the grid follows the size of the window', () => {
  let observed: Array<() => void> = [];
  let width = 800;
  let height = 400;

  beforeEach(() => {
    observed = [];
    width = 800;
    height = 400;
    vi.stubGlobal('ResizeObserver', class {
      constructor(private readonly callback: () => void) { observed.push(callback); }
      observe(): void {}
      disconnect(): void {}
    });
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(() => ({ width: 400, height: 20 } as DOMRect));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks the engine for as many rows and columns as the element holds', () => {
    const view = mount('one\ntwo\n');
    const painted = view.getByTestId('vim-body').children;
    expect(painted.length).toBe(20);
    expect(view.getAllByTestId('vim-tilde').length).toBe(17);
  });

  it('repaints at the new size when the window is resized', () => {
    const view = mount('one\ntwo\n');
    height = 200;
    act(() => { for (const callback of observed) callback(); });
    expect(view.getByTestId('vim-body').children.length).toBe(10);
  });

  it('keeps the cursor cell inside the window after the window shrinks', () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const view = mount(content);
    press(view, 'G');
    height = 100;
    act(() => { for (const callback of observed) callback(); });
    const { row } = columnOfCursor(view);
    expect(row).toBeGreaterThanOrEqual(0);
    expect(row).toBeLessThan(5);
    expect(view.getByTestId('vim-cursor').textContent).toBe('l');
  });

  it('scrolls with the mouse wheel by three lines without moving the cursor off the window', () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const view = mount(content);
    fireEvent.wheel(view.getByTestId('vim-body'), { deltaY: 100 });
    expect(view.getAllByTestId('vim-line')[0].textContent).toBe('line 4');
  });
});

describe('gridLayout', () => {
  it('turns a row into runs and marks the cursor cell', () => {
    const runs = layoutRow({ text: 'ab', spans: [{ from: 1, to: 2, style: 'special' }] }, 0);
    expect(runs).toEqual([
      { text: 'a', wide: false, style: null, paint: null, caret: true },
      { text: 'b', wide: false, style: 'special', paint: null, caret: false },
    ]);
  });

  it('pads with blanks up to a cursor placed past the end of the text', () => {
    const runs = layoutRow({ text: 'a', spans: [] }, 3);
    expect(runs.map((r) => r.text).join('')).toBe('a   ');
    expect(runs[runs.length - 1].caret).toBe(true);
  });

  it('keeps a double-width character on two columns and puts the cursor on both', () => {
    const runs = layoutRow({ text: '中\u0000x', spans: [] }, 1);
    expect(runs[0]).toEqual({ text: '中', wide: true, style: null, paint: null, caret: true });
    expect(runs[1].text).toBe('x');
  });
});

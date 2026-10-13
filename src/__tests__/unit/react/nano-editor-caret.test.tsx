/**
 * @vitest-environment jsdom
 *
 * La sonde du rendu de nano.  L'ancien composant posait un <textarea> sous un curseur superpose
 * calcule en colonnes de texte : une tabulation comptait pour UNE cellule dans `displayColumnFor`
 * alors que la zone de texte la dessine jusqu'a la tabulation suivante, la barre de titre, la barre
 * d'etat et les deux rangees de raccourcis etaient des blocs HTML sans lien avec la taille du
 * terminal, et un redimensionnement ou une ligne plus large que la fenetre decalait le curseur du
 * texte.  Le composant peint maintenant les cellules de `engine.screen` (titre, fenetre d'edition,
 * rangee d'etat, raccourcis, cellule du curseur), mesure la place qu'on lui donne et la dit au moteur.
 *
 * Mesure avec `git stash push -u -- src/components src/network` : l'ancien composant n'a ni
 * `nano-body` ni `nano-cursor` (il posait `nano-textarea` et `nano-caret`), donc les cas tombent
 * avant, sauf les TEMOINS qui prouvent que le lab tape bien dans le composant : la version
 * precedente de ce fichier posait les memes questions de curseur (bloc d'une cellule, colonne
 * apres une tabulation, colonne simple, caractere de controle sur deux cellules) et passait contre
 * l'ancien rendu ; les quatre premiers cas les reprennent.  Valeurs de reference mesurees sur GNU
 * nano 7.2 sous tmux : curseur en x=1 puis x=8 apres Droite sur `a<TAB>b`, x=3 puis 4 sur `x^Ay`.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { defaultNanoSettings } from '@/network/devices/linux/editors/nano/NanoSettings';

interface MountOptions { line?: number; col?: number; lineNumbers?: boolean; softwrap?: boolean; readOnly?: boolean }

function mount(content: string, options: MountOptions = {}) {
  const fs = new InMemoryEditorFsContext({ '/tmp/n.txt': content });
  return render(
    <NanoEditor
      filePath="/tmp/n.txt" initialContent={content} isNewFile={false} fsContext={fs}
      onExit={() => {}}
      launch={{
        settings: defaultNanoSettings({ linenumbers: options.lineNumbers === true, softwrap: options.softwrap === true, view: options.readOnly === true }),
        start: options.line === undefined ? null : { line: options.line, column: options.col ?? 0, search: null, caseSensitive: null, regex: null, alerts: [] },
      }}
    />,
  );
}

type View = ReturnType<typeof mount>;

function press(view: View, ...keys: Array<string | { key: string; ctrl?: boolean; alt?: boolean }>): void {
  const body = view.getByTestId('nano-body');
  for (const key of keys) {
    if (typeof key === 'string') fireEvent.keyDown(body, { key });
    else fireEvent.keyDown(body, { key: key.key, ctrlKey: key.ctrl === true, altKey: key.alt === true });
  }
}

function editRows(view: View): HTMLElement[] {
  return Array.from(view.getByTestId('nano-edit').children) as HTMLElement[];
}

function cursorCell(view: View): { row: number; column: number } {
  const body = view.getByTestId('nano-body');
  let row = 0;
  for (const section of Array.from(body.children) as HTMLElement[]) {
    for (const line of Array.from(section.children) as HTMLElement[]) {
      let column = 0;
      for (const span of Array.from(line.children) as HTMLElement[]) {
        if (span.getAttribute('data-testid') === 'nano-cursor') return { row, column };
        column += span.style.width === '2ch' ? 2 : span.textContent!.length;
      }
      row++;
    }
  }
  return { row: -1, column: -1 };
}

afterEach(cleanup);

describe('nano caret rendering', () => {
  it('is a one-cell block on the character under the cursor', () => {
    const view = mount('hello\n', { line: 1, col: 4 });
    const caret = view.getByTestId('nano-cursor');
    expect(caret.textContent).toBe('l');
    expect(caret.style.backgroundColor).not.toBe('');
  });

  it('sits on the character after a tab, at the next tab stop', () => {
    const view = mount('a\tb\n', { line: 1, col: 9 });
    expect(cursorCell(view)).toEqual({ row: 1, column: 8 });
    expect(view.getByTestId('nano-cursor').textContent).toBe('b');
  });

  it('witness: a plain column is its own index', () => {
    const view = mount('hello\n', { line: 1, col: 4 });
    expect(cursorCell(view)).toEqual({ row: 1, column: 3 });
  });

  it('witness: a control character takes two cells (real nano: x=3 on y, 4 at the end)', () => {
    const view = mount('x\u0001y\n', { line: 1, col: 4 });
    expect(cursorCell(view)).toEqual({ row: 1, column: 3 });
    press(view, 'ArrowRight');
    expect(cursorCell(view)).toEqual({ row: 1, column: 4 });
  });

  it('a tab counts up to the next stop wherever it falls', () => {
    const view = mount('abcdefgh\tz\n', { line: 1, col: 17 });
    expect(cursorCell(view)).toEqual({ row: 1, column: 16 });
  });

  it('a double-width letter takes two cells and the cursor covers both', () => {
    const view = mount('中文x\n', { line: 1, col: 1 });
    press(view, 'ArrowRight');
    expect(cursorCell(view)).toEqual({ row: 1, column: 2 });
  });

  it('paints a tab as the spaces up to the next tab stop', () => {
    const view = mount('a\tb\n');
    expect(editRows(view)[0].textContent).toBe('a       b');
  });

  it('moves the cursor after the line-number gutter with -l', () => {
    const view = mount('hello\n', { line: 1, col: 3, lineNumbers: true });
    expect(editRows(view)[0].textContent).toBe(' 1 hello');
    expect(cursorCell(view)).toEqual({ row: 1, column: 5 });
  });

  it('scrolls the cursor line sideways with a < marker instead of wrapping', () => {
    const view = mount(`${'0123456789'.repeat(12)}\n`, { line: 1, col: 110 });
    const row = editRows(view)[0].textContent!;
    expect(row.startsWith('<')).toBe(true);
    expect(view.getByTestId('nano-cursor').textContent).toBe('9');
  });
});

describe('nano chrome', () => {
  it('names the file in the title bar and marks the buffer Modified after an edit', () => {
    const view = mount('hello\n');
    expect(view.getByTestId('nano-titlebar').textContent).toContain('n.txt');
    expect(view.getByTestId('nano-titlebar').textContent).not.toContain('Modified');
    press(view, 'x');
    expect(view.getByTestId('nano-titlebar').textContent).toContain('Modified');
  });

  it('shows the Read message in the status row and the two rows of shortcuts', () => {
    const view = mount('hello\n');
    expect(view.getByTestId('nano-status-message').textContent).toContain('[ Read 1 line ]');
    const bars = view.getByTestId('nano-shortcut-bar').children;
    expect(bars.length).toBe(2);
    expect(bars[0].textContent).toContain('^G Help');
    expect(bars[1].textContent).toContain('^X Exit');
  });

  it('replaces the status row with the prompt and keeps the cursor on the answer', () => {
    const view = mount('hello\n');
    press(view, { key: 'w', ctrl: true }, 'a', 'b');
    const status = view.getByTestId('nano-status-message').textContent!;
    expect(status.trimEnd()).toBe('Search: ab');
    expect(cursorCell(view).column).toBe('Search: ab'.length);
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

  it('asks the engine for as many rows as the element holds: title, edit window, status, two shortcut rows', () => {
    const view = mount('one\ntwo\n');
    expect(editRows(view).length).toBe(20 - 4);
    expect(view.getByTestId('nano-shortcut-bar').children.length).toBe(2);
  });

  it('repaints at the new size when the window is resized', () => {
    const view = mount('one\ntwo\n');
    height = 200;
    act(() => { for (const callback of observed) callback(); });
    expect(editRows(view).length).toBe(10 - 4);
  });

  it('keeps the cursor cell inside the window after the window shrinks', () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const view = mount(content);
    press(view, { key: '_', ctrl: true }, '5', '0', 'Enter');
    height = 120;
    act(() => { for (const callback of observed) callback(); });
    const { row } = cursorCell(view);
    expect(row).toBeGreaterThanOrEqual(1);
    expect(row).toBeLessThan(1 + (6 - 4));
    expect(view.getByTestId('nano-cursor').textContent).toBe('l');
  });

  it('scrolls with the mouse wheel by three lines', () => {
    const content = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    const view = mount(content);
    fireEvent.wheel(view.getByTestId('nano-body'), { deltaY: 100 });
    expect(editRows(view)[0].textContent).toBe('line 4');
  });
});

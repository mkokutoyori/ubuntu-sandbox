/**
 * @vitest-environment jsdom
 *
 * Le saut bref de `showmatch` dans le composant : la parenthese fermante tapee, le curseur va sur
 * l'ouvrante, puis revient apres `matchtime` dixiemes de seconde, ou des la touche suivante.  Le
 * composant n'a aucune horloge de vim : il bascule de `screen` sur `screen.hold.then` quand le delai
 * que le moteur annonce s'est ecoule.
 *
 * Mesure avec `git stash push -- src/network src/components` : l'option est lue et ignoree, le curseur ne
 * quitte jamais la fin de la ligne, donc le premier cas tombe avant ; les deux autres passent des deux
 * cotes (le TEMOIN est le dernier : le curseur apres le delai est a la meme place que sans `showmatch`).
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { VimEditor } from '@/components/editors/VimEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';

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

function cursorColumn(view: ReturnType<typeof mount>): number {
  const rows = Array.from(view.getByTestId('vim-body').children) as HTMLElement[];
  for (const row of rows) {
    let column = 0;
    for (const span of Array.from(row.children) as HTMLElement[]) {
      if (span.getAttribute('data-testid') === 'vim-cursor') return column;
      column += span.style.width === '2ch' ? 2 : span.textContent!.length;
    }
  }
  return -1;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('showmatch in the vim component', () => {
  it('moves the cursor to the opening bracket, then back after matchtime', () => {
    const view = mount('foo(bar\n');
    press(view, ':', 's', 'e', 't', ' ', 's', 'm', 'Enter', 'A', ')');
    expect(cursorColumn(view)).toBe(3);
    act(() => { vi.advanceTimersByTime(499); });
    expect(cursorColumn(view)).toBe(3);
    act(() => { vi.advanceTimersByTime(2); });
    expect(cursorColumn(view)).toBe(8);
  });

  it('drops the jump as soon as the next key arrives', () => {
    const view = mount('foo(bar\n');
    press(view, ':', 's', 'e', 't', ' ', 's', 'm', 'Enter', 'A', ')', 'x');
    expect(cursorColumn(view)).toBe(9);
  });

  it('WITNESS: without showmatch the cursor stays after the bracket', () => {
    const view = mount('foo(bar\n');
    press(view, 'A', ')');
    expect(cursorColumn(view)).toBe(8);
  });
});

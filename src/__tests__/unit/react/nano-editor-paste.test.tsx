/**
 * @vitest-environment jsdom
 *
 * Coller dans nano depuis un autre programme (Notepad, un navigateur).  Le composant faisait `preventDefault()`
 * sur TOUTES les touches avant de les confier au moteur : or le navigateur ne declenche l'evenement `paste` que
 * si la touche de collage n'est pas annulee.  Ctrl+Maj+V, Maj+Inser et Cmd+V (les gestes d'un terminal) ne
 * collaient donc rien, et Cmd+V tapait un « v » dans le tampon.  `^V` reste « Page suivante », comme dans nano.
 * Le collage passe maintenant par l'evenement `paste` (aucune permission du navigateur) ; le clic droit lit le
 * presse-papiers comme PuTTY ou Windows Terminal ; Ctrl+Maj+C copie la selection de la fenetre.
 *
 * Mesure avec `git stash push -- src/components` : 5 des 9 tests tombent (les trois gestes de collage, le clic
 * droit et Ctrl+Maj+C, qui n'ecrivait rien dans le presse-papiers).  Les quatre qui passent avant comme apres sont
 * des TEMOINS : l'evenement `paste` colle deja un texte aux fins de ligne Windows, `^V` n'est pas un collage, une
 * touche ordinaire est toujours annulee et tapee, et un presse-papiers refuse par le navigateur ne colle rien (la
 * lecture echoue dans les deux etats).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(content: string) {
  const fs = new InMemoryEditorFsContext({ '/tmp/n.txt': content });
  return render(<NanoEditor filePath="/tmp/n.txt" initialContent={content} isNewFile={false} fsContext={fs} onExit={() => {}} />);
}

type View = ReturnType<typeof mount>;

const body = (view: View): HTMLElement => view.getByTestId('nano-body');
const textOf = (view: View): string => body(view).textContent ?? '';
const rows = (view: View): string[] => Array.from(view.getByTestId('nano-edit').children).map((row) => (row.textContent ?? '').trimEnd());

function clipboardWith(text: string | null) {
  const writeText = vi.fn(() => Promise.resolve());
  vi.stubGlobal('navigator', { clipboard: { readText: () => (text === null ? Promise.reject(new Error('denied')) : Promise.resolve(text)), writeText } });
  return writeText;
}

describe('pasting into nano', () => {
  it('WITNESS: the paste event inserts text with Windows line endings', () => {
    const view = mount('alpha\n');
    fireEvent.paste(body(view), { clipboardData: { getData: () => 'one\r\ntwo' } });
    expect(rows(view).slice(0, 2)).toEqual(['one', 'twoalpha']);
  });

  it('leaves Ctrl+Shift+V to the browser so that it fires the paste event', () => {
    const view = mount('alpha\n');
    expect(fireEvent.keyDown(body(view), { key: 'V', ctrlKey: true, shiftKey: true })).toBe(true);
  });

  it('leaves Shift+Insert to the browser', () => {
    const view = mount('alpha\n');
    expect(fireEvent.keyDown(body(view), { key: 'Insert', shiftKey: true })).toBe(true);
  });

  it('leaves Cmd+V to the browser and does not type a v', () => {
    const view = mount('alpha\n');
    expect(fireEvent.keyDown(body(view), { key: 'v', metaKey: true })).toBe(true);
    expect(rows(view)[0]).toBe('alpha');
  });

  it('WITNESS: Ctrl+V stays nano\'s Next Page and does not paste', () => {
    const view = mount('alpha\n');
    expect(fireEvent.keyDown(body(view), { key: 'v', ctrlKey: true })).toBe(false);
    expect(rows(view)[0]).toBe('alpha');
  });

  it('pastes the clipboard text on a right click', async () => {
    clipboardWith('from notepad\r\nsecond');
    const view = mount('alpha\n');
    await act(async () => {
      fireEvent.contextMenu(body(view));
    });
    expect(rows(view).slice(0, 2)).toEqual(['from notepad', 'secondalpha']);
  });

  it('pastes nothing on a right click when the browser refuses the clipboard', async () => {
    clipboardWith(null);
    const view = mount('alpha\n');
    await act(async () => {
      fireEvent.contextMenu(body(view));
    });
    expect(rows(view)[0]).toBe('alpha');
  });

  it('copies the selected text on Ctrl+Shift+C instead of reporting the cursor position', async () => {
    const writeText = clipboardWith('');
    const view = mount('alpha\n');
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(view.getByTestId('nano-edit').children[0]);
    selection.removeAllRanges();
    selection.addRange(range);
    await act(async () => {
      expect(fireEvent.keyDown(body(view), { key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(textOf(view)).not.toContain('line 1/');
  });

  it('WITNESS: an ordinary key is still swallowed and typed', () => {
    const view = mount('alpha\n');
    expect(fireEvent.keyDown(body(view), { key: 'x' })).toBe(false);
    expect(rows(view)[0]).toBe('xalpha');
  });
});

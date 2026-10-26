/**
 * @vitest-environment jsdom
 *
 * Les seize entrees de la barre de raccourcis de nano (^G Aide, ^O Ecrire, ^W Chercher, ^K Couper, ^T Executer, ^C Position,
 * M-U Annuler, M-A Marque, ^X Quitter, ^R Lire, ^\ Remplacer, ^U Coller, ^J Justifier, ^/ Aller a la ligne, M-E Refaire,
 * M-6 Copier) doivent faire ce qu'elles annoncent QUAND ON LES TAPE DANS UN NAVIGATEUR, pas seulement quand on injecte la touche
 * au moteur.  Un navigateur ne remet pas ce qu'un terminal remet : Ctrl+/ arrive comme « / » et non comme 0x1F ; sur un clavier
 * AZERTY la rangee des chiffres donne des symboles, donc Alt+6 arrive comme « - » ; AltGr arrive comme Ctrl+Alt (Windows) et
 * ouvrait « Remplacer » au lieu d'ecrire « \ » ; sur Mac Option+U arrive comme une touche morte.  Ctrl+W et Ctrl+T sont
 * gardees par le navigateur (fermer l'onglet, en ouvrir un) : la barre reste cliquable, et F6 (l'alternative de ^W que l'aide de
 * nano annonce) marche.
 *
 * Mesure avec `git stash push -- src/components src/network` : 19 des 35 tests tombent avant, 0 apres.  Avant : Ctrl+/ (rien ne se
 * passait), Ctrl+Maj+: et Alt+6 sur AZERTY, Option+U et Option+6 sur Mac, AltGr+8 (« Remplacer » au lieu de « \ ») et AltGr+0 (« @ »
 * perdu), neuf touches de fonction (F1 F3 F4 F5 F6 F9 F11 F12, puis F2 et F10) et les trois clics sur la barre.  Les 16 qui passent
 * avant comme apres sont des TEMOINS : les treize entrees QWERTY restantes (la touche, injectee comme le fait un navigateur, atteint
 * deja la fonction annoncee), Ctrl+Maj+- (^_), Alt+Maj+4 qui ne doit pas devenir Alt+4, et la lecture de la barre par `barShortcutAt`
 * (le module est neuf, le test ne depend pas des composants).  Ce que le test ne peut pas verifier : jsdom ne ferme pas d'onglet,
 * donc que le navigateur garde vraiment Ctrl+W et Ctrl+T (c'est le cas de Chrome, Firefox, Edge et Safari hors plein ecran).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { barShortcutAt, editorKeyOf } from '@/components/editors/browserKeys';
import { measureCell } from '@/components/gridGeometry';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

interface Press { key: string; ctrl?: boolean; alt?: boolean; shift?: boolean; code?: string; altGraph?: boolean }

function mount(content = 'alpha beta\ngamma delta\n') {
  const exits: boolean[] = [];
  const fs = new InMemoryEditorFsContext({ '/tmp/n.txt': content });
  const view = render(<NanoEditor filePath="/tmp/n.txt" initialContent={content} isNewFile={false} fsContext={fs} onExit={() => exits.push(true)} />);
  return { view, exits };
}

type Lab = ReturnType<typeof mount>;

function press(lab: Lab, ...keys: Press[]): void {
  const body = lab.view.getByTestId('nano-body');
  for (const k of keys) {
    fireEvent.keyDown(body, {
      key: k.key, code: k.code, ctrlKey: k.ctrl === true, altKey: k.alt === true, shiftKey: k.shift === true, modifierAltGraph: k.altGraph === true,
    });
  }
}

const ctrl = (key: string): Press => ({ key, ctrl: true });
const alt = (key: string): Press => ({ key, alt: true });
const status = (lab: Lab): string => (lab.view.getByTestId('nano-status-message').textContent ?? '').trim();
const title = (lab: Lab): string => (lab.view.getByTestId('nano-titlebar').textContent ?? '').trim();
const rows = (lab: Lab): string[] => Array.from(lab.view.getByTestId('nano-edit').children).map((row) => (row.textContent ?? '').trimEnd());
const cutThenUndo: Press[] = [ctrl('k'), alt('u')];

describe('the sixteen entries of the shortcut bar, typed the way a QWERTY browser delivers them', () => {
  it('^G Help opens the help text', () => {
    const lab = mount();
    press(lab, ctrl('g'));
    expect(title(lab)).toBe('Main nano help text');
  });

  it('^O Write Out asks for the file name', () => {
    const lab = mount();
    press(lab, ctrl('o'));
    expect(status(lab)).toBe('File Name to Write: /tmp/n.txt');
  });

  it('^W Where Is opens the search prompt', () => {
    const lab = mount();
    press(lab, ctrl('w'));
    expect(status(lab)).toBe('Search:');
  });

  it('^K Cut removes the line and ^U Paste puts it back', () => {
    const lab = mount();
    press(lab, ctrl('k'));
    expect(rows(lab)[0]).toBe('gamma delta');
    press(lab, ctrl('u'));
    expect(rows(lab).slice(0, 2)).toEqual(['alpha beta', 'gamma delta']);
  });

  it('^T Execute asks for a command', () => {
    const lab = mount();
    press(lab, ctrl('t'));
    expect(status(lab)).toBe('Command to execute:');
  });

  it('^C Location reports the cursor position', () => {
    const lab = mount();
    press(lab, ctrl('c'));
    expect(status(lab)).toContain('line  1/3');
  });

  it('M-U Undo reverts a cut and M-E Redo does it again', () => {
    const lab = mount();
    press(lab, ...cutThenUndo);
    expect(status(lab)).toBe('[ Undid cut ]');
    expect(rows(lab)[0]).toBe('alpha beta');
    press(lab, alt('e'));
    expect(status(lab)).toBe('[ Redid cut ]');
    expect(rows(lab)[0]).toBe('gamma delta');
  });

  it('M-A Set Mark announces the mark', () => {
    const lab = mount();
    press(lab, alt('a'));
    expect(status(lab)).toBe('[ Mark Set ]');
  });

  it('^X Exit leaves an unmodified buffer', () => {
    const lab = mount();
    press(lab, ctrl('x'));
    expect(lab.exits).toEqual([true]);
  });

  it('^R Read File asks for a file to insert', () => {
    const lab = mount();
    press(lab, ctrl('r'));
    expect(status(lab)).toBe('File to insert [from ./]:');
  });

  it('^\\ Replace opens the replace prompt', () => {
    const lab = mount();
    press(lab, ctrl('\\'));
    expect(status(lab)).toBe('Search (to replace):');
  });

  it('^J Justify joins the paragraph', () => {
    const lab = mount();
    press(lab, ctrl('j'));
    expect(status(lab)).toBe('[ Justified paragraph ]');
    expect(rows(lab)[0]).toBe('alpha beta gamma delta');
  });

  it('M-6 Copy puts the selection in the cut buffer without removing it', () => {
    const lab = mount();
    press(lab, alt('a'), ...Array.from({ length: 5 }, () => ({ key: 'ArrowRight' })), alt('6'), { key: 'ArrowDown' }, ctrl('u'));
    expect(rows(lab).slice(0, 2)).toEqual(['alpha beta', 'gammaalpha delta']);
  });

  it('^/ Go To Line (Ctrl+/ as a browser sends it) opens the Go To Line prompt', () => {
    const lab = mount();
    press(lab, { key: '/', ctrl: true });
    expect(status(lab)).toBe('Enter line number, column number:');
  });
});

describe('the same entries on the keyboards a French user has', () => {
  it('Ctrl+Shift+: on AZERTY (the browser sends « / » with Shift) opens Go To Line', () => {
    const lab = mount();
    press(lab, { key: '/', ctrl: true, shift: true, code: 'Period' });
    expect(status(lab)).toBe('Enter line number, column number:');
  });

  it('Ctrl+Shift+- (^_) still opens Go To Line', () => {
    const lab = mount();
    press(lab, { key: '_', ctrl: true, shift: true });
    expect(status(lab)).toBe('Enter line number, column number:');
  });

  it('Alt+6 on AZERTY (the key labelled 6 sends « - ») is M-6 Copy', () => {
    const lab = mount();
    press(lab, alt('a'), ...Array.from({ length: 5 }, () => ({ key: 'ArrowRight' })), { key: '-', alt: true, code: 'Digit6' }, { key: 'ArrowDown' }, ctrl('u'));
    expect(rows(lab)[1]).toBe('gammaalpha delta');
  });

  it('Option+U on a Mac (a dead key) is M-U Undo', () => {
    const lab = mount();
    press(lab, ctrl('k'), { key: 'Dead', alt: true, code: 'KeyU' });
    expect(status(lab)).toBe('[ Undid cut ]');
  });

  it('Option+6 on a Mac (« § ») is M-6 Copy', () => {
    const lab = mount();
    press(lab, alt('a'), ...Array.from({ length: 5 }, () => ({ key: 'ArrowRight' })), { key: '§', alt: true, code: 'Digit6' }, { key: 'ArrowDown' }, ctrl('u'));
    expect(rows(lab)[1]).toBe('gammaalpha delta');
  });

  it('AltGr+8 writes a backslash instead of opening Replace', () => {
    const lab = mount();
    press(lab, { key: '\\', ctrl: true, alt: true, code: 'Digit8', altGraph: true });
    expect(status(lab)).not.toBe('Search (to replace):');
    expect(rows(lab)[0]).toBe('\\alpha beta');
  });

  it('AltGr+0 writes an at sign', () => {
    const lab = mount();
    press(lab, { key: '@', ctrl: true, alt: true, code: 'Digit0', altGraph: true });
    expect(rows(lab)[0]).toBe('@alpha beta');
  });

  it('Alt+Shift+4 on QWERTY stays M-$ and is not turned into M-4', () => {
    expect(editorKeyOf({ key: '$', code: 'Digit4', ctrlKey: false, shiftKey: true, altKey: true })).toEqual({ key: '$', ctrl: false, shift: true, alt: true });
  });
});

describe('the function keys that nano documents next to ^G, ^X, ^O, ^J, ^R, ^W, ^K, ^U and ^C', () => {
  const effects: ReadonlyArray<readonly [string, (lab: Lab) => void]> = [
    ['F1', (lab) => expect(title(lab)).toBe('Main nano help text')],
    ['F3', (lab) => expect(status(lab)).toBe('File Name to Write: /tmp/n.txt')],
    ['F4', (lab) => expect(status(lab)).toBe('[ Justified paragraph ]')],
    ['F5', (lab) => expect(status(lab)).toBe('File to insert [from ./]:')],
    ['F6', (lab) => expect(status(lab)).toBe('Search:')],
    ['F9', (lab) => expect(rows(lab)[0]).toBe('gamma delta')],
    ['F11', (lab) => expect(status(lab)).toContain('line  1/3')],
    ['F12', (lab) => expect(status(lab)).toBe('[ Error invoking "spell" ]')],
  ];
  it.each(effects)('%s', (key, check) => {
    const lab = mount();
    press(lab, { key });
    check(lab);
  });

  it('F2 exits and F10 pastes', () => {
    const lab = mount();
    press(lab, ctrl('k'), { key: 'F10' });
    expect(rows(lab)[0]).toBe('alpha beta');
    press(lab, { key: 'F2' });
    expect(lab.exits.length + (status(lab).includes('Save modified buffer') ? 1 : 0)).toBeGreaterThan(0);
  });
});

describe('clicking an entry of the bar, for the keys the browser keeps (Ctrl+W closes the tab, Ctrl+T opens one)', () => {
  function geometry(lab: Lab): { cell: number; barsFrom: number } {
    const body = lab.view.getByTestId('nano-body');
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return (this.getAttribute('aria-hidden') === 'true' ? { width: 400, height: 20, left: 0, top: 0 } : { width: 800, height: 480, left: 0, top: 0 }) as DOMRect;
    });
    const cell = measureCell(body);
    const above = ['nano-titlebar', 'nano-edit', 'nano-status-message'].reduce((sum, id) => sum + lab.view.getByTestId(id).children.length, 0);
    return { cell, barsFrom: above };
  }

  const barText = (lab: Lab): string[] => Array.from(lab.view.getByTestId('nano-shortcut-bar').children).map((row) => row.textContent ?? '');

  it('a click on ^T Execute opens the Execute prompt', () => {
    const lab = mount();
    const { cell, barsFrom } = geometry(lab);
    const column = barText(lab)[0].indexOf('^T');
    fireEvent.mouseUp(lab.view.getByTestId('nano-body'), { clientX: column * cell + 2, clientY: barsFrom * 20 + 4 });
    expect(status(lab)).toBe('Command to execute:');
  });

  it('a click on ^W Where Is opens the search prompt', () => {
    const lab = mount();
    const { cell, barsFrom } = geometry(lab);
    const column = barText(lab)[0].indexOf('^W');
    fireEvent.mouseUp(lab.view.getByTestId('nano-body'), { clientX: column * cell + 2, clientY: barsFrom * 20 + 4 });
    expect(status(lab)).toBe('Search:');
  });

  it('a click on the second row, ^X Exit, leaves the editor', () => {
    const lab = mount();
    const { cell, barsFrom } = geometry(lab);
    const column = barText(lab)[1].indexOf('^X');
    fireEvent.mouseUp(lab.view.getByTestId('nano-body'), { clientX: column * cell + 2, clientY: (barsFrom + 1) * 20 + 4 });
    expect(lab.exits).toEqual([true]);
  });

  it('barShortcutAt reads the entry under a column from the text of the two bar rows', () => {
    const rowsOfBar = ['^G Help      ^O Write Out ^W Where Is  ^K Cut', '^X Exit      ^R Read File ^\\ Replace   ^U Paste'];
    expect(barShortcutAt(rowsOfBar, 0, 14)).toEqual({ key: 'o', ctrl: true, shift: false, alt: false });
    expect(barShortcutAt(rowsOfBar, 1, 26)).toEqual({ key: '\\', ctrl: true, shift: false, alt: false });
    expect(barShortcutAt(rowsOfBar, 1, 60)).toBeNull();
  });
});

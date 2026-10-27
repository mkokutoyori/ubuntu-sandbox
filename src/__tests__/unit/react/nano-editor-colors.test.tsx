/**
 * @vitest-environment jsdom
 *
 * Le rendu des couleurs de nano : le moteur donne, par cellule, une peinture (`Paint` : couleurs de la palette
 * 256, gras, italique, souligne, inverse) et le composant la traduit en style.  Les valeurs de reference de
 * la palette sont celles de xterm-256color (cube 6x6x6 de niveaux 0, 95, 135, 175, 215, 255, rampe de gris 8 + 10 n).
 *
 * Mesure avec `git stash push -u -- src/components src/network` : le fichier ne se charge pas (paintCss n'existe pas), donc
 * les cinq cas tombent avant, aucun ne passe des deux cotes.  Le premier cas, qui verifie que le titre sans `titlecolor`
 * garde le style `reverse` de la grille, est le TEMOIN apres : il prouve que le rendu des peintures n'a pas change l'ancien.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { NanoEditor } from '@/components/editors/NanoEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { defaultNanoSettings } from '@/network/devices/linux/editors/nano/NanoSettings';
import { parseCombination, type ElementCombinations } from '@/network/devices/linux/editors/nano/NanoPaint';
import { paintStyle, paletteColor } from '@/components/editors/paintCss';

function mount(colors: ElementCombinations) {
  const fs = new InMemoryEditorFsContext({ '/tmp/n.txt': 'hello\n' });
  return render(
    <NanoEditor
      filePath="/tmp/n.txt" initialContent={'hello\n'} isNewFile={false} fsContext={fs}
      onExit={() => {}}
      launch={{ settings: defaultNanoSettings({ colors }), start: null }}
    />,
  );
}

function combination(specification: string) {
  const outcome = parseCombination(specification);
  if ('error' in outcome) throw new Error(outcome.error);
  return outcome.combination;
}

function titleRun(view: ReturnType<typeof mount>): HTMLElement {
  const body = view.getByTestId('nano-body');
  return body.querySelector('div > span') as HTMLElement;
}

afterEach(cleanup);

describe('nano colour rendering', () => {
  it('WITNESS: the title bar without a titlecolor keeps the grid reverse style', () => {
    const view = mount({});
    expect(titleRun(view).style.backgroundColor).toBe('rgb(211, 215, 207)');
  });

  it('paints the title bar with the colours of titlecolor', () => {
    const view = mount({ title: combination('red,green') });
    const run = titleRun(view);
    expect(run.style.color).toBe('rgb(204, 0, 0)');
    expect(run.style.backgroundColor).toBe('rgb(78, 154, 6)');
  });

  it('maps the 256-colour palette like xterm', () => {
    expect([paletteColor(1), paletteColor(16), paletteColor(21), paletteColor(196), paletteColor(231), paletteColor(232), paletteColor(255)])
      .toEqual(['#cc0000', '#000000', '#0000ff', '#ff0000', '#ffffff', '#080808', '#eeeeee']);
  });

  it('swaps foreground and background for a reverse paint, using the terminal colours for the defaults', () => {
    expect(paintStyle({ fg: null, bg: null, bold: false, italic: false, underline: false, reverse: true })).toEqual({ color: '#300a24', backgroundColor: '#d3d7cf' });
    expect(paintStyle({ fg: 1, bg: 2, bold: false, italic: false, underline: false, reverse: true })).toEqual({ color: '#4e9a06', backgroundColor: '#cc0000' });
  });

  it('carries bold, italic and underline', () => {
    expect(paintStyle({ fg: null, bg: null, bold: true, italic: true, underline: true, reverse: false })).toMatchObject({ fontWeight: 'bold', fontStyle: 'italic', textDecoration: 'underline' });
  });
});

/**
 * @vitest-environment jsdom
 *
 * AltGr sur un clavier AZERTY arrive du navigateur comme Ctrl+Alt (Windows) : vim ne recevait qu'une touche Ctrl+Alt qu'il
 * ignore, donc « \ », « @ », « { », « [ » et « | » ne pouvaient pas etre ecrits.  Le composant remet maintenant le caractere
 * produit, sans modificateur.
 *
 * Mesure avec `git stash push -- src/components` : les deux tests tombent avant, 0 apres ; le TEMOIN (une lettre ordinaire en
 * mode Insertion) passe des deux cotes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { VimEditor } from '@/components/editors/VimEditor';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';

afterEach(cleanup);

function mount() {
  const fs = new InMemoryEditorFsContext({ '/tmp/c.txt': 'x\n' });
  return render(<VimEditor filePath="/tmp/c.txt" initialContent={'x\n'} isNewFile={false} editorName="vim" fsContext={fs} onExit={() => {}} />);
}

function type(view: ReturnType<typeof mount>, init: { key: string; ctrlKey?: boolean; altKey?: boolean; modifierAltGraph?: boolean; code?: string }): void {
  fireEvent.keyDown(view.getByTestId('vim-body'), init);
}

const firstRow = (view: ReturnType<typeof mount>): string => (view.container.textContent ?? '');

describe('vim receives the character AltGr produces', () => {
  it('WITNESS: a plain letter is inserted in Insert mode', () => {
    const view = mount();
    type(view, { key: 'i' });
    type(view, { key: 'q' });
    expect(firstRow(view)).toContain('qx');
  });

  it('AltGr+8 inserts a backslash', () => {
    const view = mount();
    type(view, { key: 'i' });
    type(view, { key: '\\', ctrlKey: true, altKey: true, modifierAltGraph: true, code: 'Digit8' });
    expect(firstRow(view)).toContain('\\x');
  });

  it('AltGr+0 inserts an at sign', () => {
    const view = mount();
    type(view, { key: 'i' });
    type(view, { key: '@', ctrlKey: true, altKey: true, modifierAltGraph: true, code: 'Digit0' });
    expect(firstRow(view)).toContain('@x');
  });
});

/**
 * Scénario 15 (auto-conçu) — Rappel d'historique dans les invites de
 * ligne de commande : `:` et `/` de vim, et `Search:` de nano, via
 * Haut/Bas — une fonctionnalité standard et documentée de ces deux
 * éditeurs, pas une extension inventée.
 *
 * Sémantique réelle reproduite :
 *  - Haut recule dans l'historique (la plus récente entrée en premier) ;
 *    Bas avance vers le présent, jusqu'à retrouver la ligne en cours de
 *    frappe (vide, en général) une fois l'entrée la plus récente
 *    dépassée.
 *  - Remonter au-delà de la plus ancienne entrée reste sur la plus
 *    ancienne (pas de bouclage, comme le vrai vim/nano).
 *  - Le texte rappelé reste éditable : taper après un rappel modifie la
 *    ligne normalement.
 *  - Chaque validation (Entrée) enregistre la ligne dans l'historique,
 *    y compris une recherche qui ne trouve rien (comportement réel de
 *    vim : la chaîne est mémorisée même si `E486` est affiché).
 *
 * Portée assumée : pas de filtrage par préfixe (taper des caractères
 * puis Haut pour ne rappeler que les entrées qui commencent pareil,
 * un raffinement réel de vim) ; pas de persistance entre sessions
 * (`viminfo`/`historylog` sur disque) — un historique en mémoire, pour
 * la durée de la session d'édition en cours, tel que documenté comme le
 * comportement de base.
 *
 * TDD: written against the headless VimEngine/NanoEngine, before any
 * history-recall state exists (confirmed via grep: no "History" in
 * either engine file).
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) press(engine, ch);
}
/** Real nano's search prompt prefills the previous term with the cursor at the end (not pre-selected) -- a real user backspaces it away first, exactly like this helper does. */
function clearPromptField(engine: { applyKey(k: EditorKeyInput): void }): void {
  for (let i = 0; i < 64; i++) press(engine, 'Backspace');
}
function makeVim(content = 'a\nb\nc\n', path = '/tmp/hist.txt'): VimEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new VimEngine(fs, path, content, false, 'vim');
}
function makeNano(content = 'a\nb\nc\n', path = '/tmp/hist.txt'): NanoEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new NanoEngine(fs, path, content, false, false);
}

describe('Scénario 15 — vim : rappel Haut/Bas dans la ligne de commande (:)', () => {
  it("Haut sans historique ne fait rien (la ligne reste vide)", () => {
    const vim = makeVim();
    press(vim, ':');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('');
  });

  it('Haut rappelle la dernière commande exécutée', () => {
    const vim = makeVim();
    press(vim, ':'); typeText(vim, 'set number'); press(vim, 'Enter');
    press(vim, ':');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('set number');
  });

  it('plusieurs Haut successifs reculent vers les commandes les plus anciennes', () => {
    const vim = makeVim();
    press(vim, ':'); typeText(vim, 'set number'); press(vim, 'Enter');
    press(vim, ':'); typeText(vim, 'set list'); press(vim, 'Enter');
    press(vim, ':');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('set list');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('set number');
  });

  it("Haut au-delà de la plus ancienne entrée n'avance plus (pas de bouclage)", () => {
    const vim = makeVim();
    press(vim, ':'); typeText(vim, 'set number'); press(vim, 'Enter');
    press(vim, ':');
    press(vim, 'ArrowUp');
    press(vim, 'ArrowUp');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('set number');
  });

  it("Bas ramène vers l'entrée la plus récente, puis vers la ligne vide de départ", () => {
    const vim = makeVim();
    press(vim, ':'); typeText(vim, 'set number'); press(vim, 'Enter');
    press(vim, ':'); typeText(vim, 'set list'); press(vim, 'Enter');
    press(vim, ':');
    press(vim, 'ArrowUp'); press(vim, 'ArrowUp'); // -> 'set number'
    expect(vim.commandLineText).toBe('set number');
    press(vim, 'ArrowDown');
    expect(vim.commandLineText).toBe('set list');
    press(vim, 'ArrowDown');
    expect(vim.commandLineText).toBe('');
  });

  it('le texte rappelé reste éditable : taper après un rappel le modifie normalement', () => {
    const vim = makeVim();
    press(vim, ':'); typeText(vim, 'set list'); press(vim, 'Enter');
    press(vim, ':');
    press(vim, 'ArrowUp');
    typeText(vim, '!');
    expect(vim.commandLineText).toBe('set list!');
  });

  it("une nouvelle commande après navigation dans l'historique s'ajoute comme entrée la plus récente", () => {
    const vim = makeVim();
    press(vim, ':'); typeText(vim, 'set number'); press(vim, 'Enter');
    press(vim, ':'); press(vim, 'ArrowUp'); press(vim, 'Escape');
    press(vim, ':'); typeText(vim, 'set list'); press(vim, 'Enter');

    press(vim, ':');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('set list');
    press(vim, 'ArrowUp');
    expect(vim.commandLineText).toBe('set number');
  });
});

describe('Scénario 15 — vim : rappel Haut/Bas dans la recherche (/)', () => {
  it('Haut rappelle le dernier motif recherché, y compris un motif qui n\'a rien trouvé', () => {
    const vim = makeVim('alpha\nbeta\n');
    press(vim, '/'); typeText(vim, 'zzz-not-found'); press(vim, 'Enter'); // E486, but still recorded
    press(vim, '/'); typeText(vim, 'beta'); press(vim, 'Enter');

    press(vim, '/');
    press(vim, 'ArrowUp');
    expect(vim.searchText).toBe('beta');
    press(vim, 'ArrowUp');
    expect(vim.searchText).toBe('zzz-not-found');
  });
});

describe('Scénario 15 — nano : rappel Haut/Bas dans l\'invite Search:', () => {
  it("Haut rappelle le dernier terme cherché", () => {
    const nano = makeNano('alpha\nbeta\ngamma\n');
    press(nano, 'w', { ctrl: true });
    typeText(nano, 'alpha');
    press(nano, 'Enter');

    press(nano, 'w', { ctrl: true });
    press(nano, 'ArrowUp');
    expect(nano.searchQuery).toBe('alpha');
  });

  it('plusieurs recherches successives : Haut/Haut recule ; Bas/Bas revient au texte pré-rempli du prompt (le dernier terme cherché — jamais vide, comme le vrai nano)', () => {
    const nano = makeNano('alpha\nbeta\ngamma\n');
    press(nano, 'w', { ctrl: true }); typeText(nano, 'alpha'); press(nano, 'Enter');
    press(nano, 'w', { ctrl: true }); clearPromptField(nano); typeText(nano, 'beta'); press(nano, 'Enter');

    // Real nano prefills Ctrl+W with the last search term -- here 'beta',
    // already the newest history entry, so the first Up doesn't visibly
    // change anything; the second Up reaches the older 'alpha'.
    press(nano, 'w', { ctrl: true });
    expect(nano.searchQuery).toBe('beta');
    press(nano, 'ArrowUp');
    expect(nano.searchQuery).toBe('beta');
    press(nano, 'ArrowUp');
    expect(nano.searchQuery).toBe('alpha');

    press(nano, 'ArrowDown');
    expect(nano.searchQuery).toBe('beta');
    press(nano, 'ArrowDown'); // past the newest entry -- restores the prefilled prompt text, not a blank line
    expect(nano.searchQuery).toBe('beta');
  });

  it("Haut sans historique ne fait rien", () => {
    const nano = makeNano();
    press(nano, 'w', { ctrl: true });
    press(nano, 'ArrowUp');
    expect(nano.searchQuery).toBe('');
  });

  it('le texte rappelé reste éditable', () => {
    const nano = makeNano('alpha beta\n');
    press(nano, 'w', { ctrl: true }); typeText(nano, 'alpha'); press(nano, 'Enter');
    press(nano, 'w', { ctrl: true });
    press(nano, 'ArrowUp');
    typeText(nano, 'X');
    expect(nano.searchQuery).toBe('alphaX');
  });
});

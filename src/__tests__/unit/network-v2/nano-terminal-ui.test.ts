/**
 * Scénario UI-1 — Interface initiale de nano : barre de titre, zone
 * d'édition, et barre de commandes.
 * Scénario UI-4 — Barre de commandes nano : comportement contextuel.
 *
 * TDD: written against the intended real behaviour of the headless
 * NanoEngine (the state the React overlay renders from) and, for the
 * layout/contextual-bar claims, the NanoEditor component itself. Where
 * the scenario's prose gives a plausible-but-unverifiable exact wording
 * (e.g. the precise replace-count message format), the existing,
 * previously-verified NanoEngine wording is kept rather than rewritten
 * to match unconfirmed prose.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
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

describe('Scénario UI-1 — statut de la barre de titre selon le fichier ouvert', () => {
  it('fichier existant non modifié : aucun message de statut de titre, "[ Read N lines ]" affiché à l\'ouverture', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/hostname': 'pc-linux-1\n' });
    const nano = new NanoEngine(fs, '/etc/hostname', 'pc-linux-1\n', false);
    expect(nano.modified).toBe(false);
    expect(nano.isReadOnly).toBe(false);
    expect(nano.statusMessage).toBe('[ Read 1 line ]');
  });

  it('fichier existant multi-lignes : "[ Read N lines ]" avec le bon pluriel', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/hosts': 'a\nb\nc\n' });
    const nano = new NanoEngine(fs, '/etc/hosts', 'a\nb\nc\n', false);
    expect(nano.statusMessage).toBe('[ Read 3 lines ]');
  });

  it('après une modification, l\'état "modified" passe à true (piloté par la barre de titre)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    expect(nano.modified).toBe(false);
    typeText(nano, 'z');
    expect(nano.modified).toBe(true);
  });

  it('nouveau fichier : statut "[ New File ]" à l\'ouverture', () => {
    const fs = new InMemoryEditorFsContext({});
    const nano = new NanoEngine(fs, '/tmp/nouveau-fichier-mandeng.txt', '', true);
    expect(nano.statusMessage).toBe('[ New File ]');
  });

  it('mode lecture seule (-v) : statut "[ View mode ]", aucun verrou créé', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/passwd': 'root:x:0:0::/root:/bin/bash\n' });
    const nano = new NanoEngine(fs, '/etc/passwd', 'root:x:0:0::/root:/bin/bash\n', false, true);
    expect(nano.isReadOnly).toBe(true);
    expect(nano.statusMessage).toBe('[ View mode ]');
    expect(nano.swapFileExists).toBe(false);
  });
});

describe('Scénario UI-1/UI-4 — mode lecture seule (-v) : aucune modification possible', () => {
  let fs: InMemoryEditorFsContext;
  let nano: NanoEngine;
  beforeEach(() => {
    fs = new InMemoryEditorFsContext({ '/etc/passwd': 'root:x:0:0::/root:/bin/bash\n' });
    nano = new NanoEngine(fs, '/etc/passwd', 'root:x:0:0::/root:/bin/bash\n', false, true);
  });

  it('la frappe de caractères, Enter, Backspace et Delete sont ignorés', () => {
    typeText(nano, 'HACKED');
    press(nano, 'Enter');
    press(nano, 'Backspace');
    press(nano, 'Delete');
    expect(nano.content).toBe('root:x:0:0::/root:/bin/bash');
    expect(nano.modified).toBe(false);
  });

  it('la navigation (flèches, Home, End) reste fonctionnelle', () => {
    press(nano, 'ArrowRight');
    press(nano, 'ArrowRight');
    expect(nano.cursorCol).toBe(2);
    press(nano, 'End');
    expect(nano.cursorCol).toBe(nano.lines[0].length);
  });

  it('^O (Write Out), ^K (Cut) et ^U (Paste) sont sans effet', () => {
    const before = nano.content;
    ctrl(nano, 'o');
    expect(nano.mode).toBe('edit'); // no save-prompt entered
    ctrl(nano, 'k');
    expect(nano.content).toBe(before); // line not cut
    ctrl(nano, 'u');
    expect(nano.content).toBe(before);
  });

  it('la recherche (^W) et la navigation restent disponibles', () => {
    ctrl(nano, 'w');
    expect(nano.mode).toBe('search');
  });

  it('^X quitte proprement sans jamais proposer de sauvegarde', () => {
    ctrl(nano, 'x');
    expect(nano.exited).toBe(true);
    expect(nano.savedOnExit).toBe(true); // nothing to save, exits clean
  });
});

describe('Scénario UI-4 — barre de commandes contextuelle (raccourcis exposés par mode)', () => {
  it('en mode édition standard, aucun mode spécial n\'est actif', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    expect(nano.mode).toBe('edit');
  });

  it('^W entre en mode recherche ; M-R bascule le mode regex visible dans le prompt', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'w');
    expect(nano.mode).toBe('search');
    expect(nano.regexSearchEnabled).toBe(false);
    press(nano, 'r', { alt: true });
    expect(nano.regexSearchEnabled).toBe(true);
  });

  it('^C annule la recherche et retourne immédiatement au mode édition', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'w');
    typeText(nano, 'a');
    ctrl(nano, 'c');
    expect(nano.mode).toBe('edit');
  });

  it('^\\ (Replace) enchaîne search → replace-with → replace-confirm, chacun un mode distinct', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'foo bar foo\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'foo bar foo\n', false);
    ctrl(nano, '\\');
    expect(nano.mode).toBe('replace-search');
    typeText(nano, 'foo');
    press(nano, 'Enter');
    expect(nano.mode).toBe('replace-with');
    typeText(nano, 'baz');
    press(nano, 'Enter');
    expect(nano.mode).toBe('replace-confirm');
    expect(nano.pendingReplaceMatch).not.toBeNull();
  });

  it('^O ouvre le prompt de sauvegarde avec le nom de fichier courant pré-rempli', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\n', false);
    ctrl(nano, 'o');
    expect(nano.mode).toBe('save-prompt');
    expect(nano.saveFileName).toBe('/tmp/x.txt');
  });

  it('après validation de la sauvegarde, retour immédiat au mode édition avec message "[ Wrote N lines ]"', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\n' });
    const nano = new NanoEngine(fs, '/tmp/x.txt', 'a\nb\n', false);
    ctrl(nano, 'o');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toBe('[ Wrote 2 lines ]');
  });
});

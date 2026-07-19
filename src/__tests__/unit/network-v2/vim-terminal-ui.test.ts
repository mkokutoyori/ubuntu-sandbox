/**
 * Scénario UI-2 — Interface vim : mode line, numéros de ligne,
 * position/pourcentage (Top/Bot/All/N%).
 * Scénario UI-3 — Interface vi : différences visuelles avec vim
 * (absence de `-- INSERT --`, ligne de statut minimale).
 * Scénario UI-5 — Retours visuels vim : messages de confirmation et
 * codes d'erreur exacts (E37/E45/E212/E492/E325).
 *
 * TDD: written against the headless VimEngine (the state the React
 * overlay renders from) plus the pure `vimPositionLabel` helper the
 * component uses for its Top/Bot/All/N% ruler. Full syntax highlighting
 * and live search-match highlighting are NOT implemented — they would
 * require replacing the plain <textarea> content area with a per-token
 * span renderer, a much larger architectural change out of scope here;
 * this is a deliberate, disclosed limitation rather than a faked pass.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { vimPositionLabel } from '@/components/editors/VimEditor';

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

describe('Scénario UI-2 — numéros de ligne : :set number / :set relativenumber', () => {
  let vim: VimEngine;
  beforeEach(() => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\nc\n' });
    vim = new VimEngine(fs, '/tmp/x.txt', 'a\nb\nc\n', false, 'vim');
  });

  it('les numéros de ligne sont désactivés par défaut (comme le vrai vim)', () => {
    expect(vim.lineNumbersShown).toBe(false);
    expect(vim.relativeNumbersShown).toBe(false);
  });

  it(':set number active les numéros absolus, :set nonumber les désactive', () => {
    exCmd(vim, 'set number');
    expect(vim.lineNumbersShown).toBe(true);
    exCmd(vim, 'set nonumber');
    expect(vim.lineNumbersShown).toBe(false);
  });

  it(':set relativenumber active les numéros relatifs, indépendamment de :set number', () => {
    exCmd(vim, 'set relativenumber');
    expect(vim.relativeNumbersShown).toBe(true);
    expect(vim.lineNumbersShown).toBe(false); // independent toggle
    exCmd(vim, 'set norelativenumber');
    expect(vim.relativeNumbersShown).toBe(false);
  });

  it(':set nu / :set nonu sont acceptés comme alias courts', () => {
    exCmd(vim, 'set nu');
    expect(vim.lineNumbersShown).toBe(true);
    exCmd(vim, 'set nonu');
    expect(vim.lineNumbersShown).toBe(false);
  });
});

describe('Scénario UI-2 — position/pourcentage dans la mode line (Top/Bot/All/N%)', () => {
  it('"All" quand tout le fichier tient dans la fenêtre visible', () => {
    expect(vimPositionLabel(0, 5, 30)).toBe('All');
    expect(vimPositionLabel(4, 5, 30)).toBe('All');
  });

  it('"Top" quand le curseur est sur la première ligne d\'un fichier trop long', () => {
    expect(vimPositionLabel(0, 100, 30)).toBe('Top');
  });

  it('"Bot" quand le curseur est sur la dernière ligne d\'un fichier trop long', () => {
    expect(vimPositionLabel(99, 100, 30)).toBe('Bot');
  });

  it('un pourcentage entre Top et Bot pour un fichier trop long', () => {
    expect(vimPositionLabel(49, 100, 30)).toBe('50%');
  });
});

describe('Scénario UI-3 — vi n\'affiche jamais -- INSERT --, contrairement à vim', () => {
  it('vim affiche -- INSERT -- en entrant en mode insertion', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    press(vim, 'i');
    expect(vim.mode).toBe('insert');
    expect(vim.message).toBe('-- INSERT --');
  });

  it('vi n\'affiche jamais -- INSERT --, bien qu\'il entre réellement en mode insertion', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vi = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vi');
    press(vi, 'i');
    expect(vi.mode).toBe('insert'); // the mode is real — only the indicator is suppressed
    expect(vi.message).toBe('');
  });
});

describe('Scénario UI-5 — messages de confirmation et codes d\'erreur exacts', () => {
  it(':w confirme avec le nombre de lignes et d\'octets (UTF-8) réellement écrits', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\nb\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\nb\n', false, 'vim');
    exCmd(vim, 'w');
    expect(vim.message).toBe('"/tmp/x.txt" 2L, 4B written');
  });

  it(':w compte les octets UTF-8 réels, pas la longueur de la chaîne JS (accents multi-octets)', () => {
    const content = 'café\n'; // 'é' is 2 bytes in UTF-8 but 1 JS string char
    const fs = new InMemoryEditorFsContext({ '/tmp/accents.txt': content });
    const vim = new VimEngine(fs, '/tmp/accents.txt', content, false, 'vim');
    exCmd(vim, 'w');
    // "café\n" = c,a,f,é(2 bytes),\n = 6 bytes, not 5 JS chars
    expect(vim.message).toBe('"/tmp/accents.txt" 1L, 6B written');
  });

  it('E492 pour une commande ex inconnue', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    exCmd(vim, 'commande_inexistante');
    expect(vim.message).toBe('E492: Not an editor command: commande_inexistante');
  });

  it('E37 pour :q avec des modifications non sauvegardées', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    press(vim, 'A'); typeText(vim, 'x'); press(vim, 'Escape');
    exCmd(vim, 'q');
    expect(vim.message).toBe('E37: No write since last change (add ! to override)');
    expect(vim.exited).toBe(false);
  });

  // E45 ('readonly' option set) is reached via the swap-recovery
  // (O)pen-read-only flow — already covered end-to-end in
  // vim-swap-recovery.test.ts ("O (open read-only) ... refuse :w sans !").

  it('E212 quand l\'écriture système échoue réellement (permission refusée)', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/shadow': 'root:!:19000:0:99999:7:::\n' });
    const original = fs.writeFile.bind(fs);
    fs.writeFile = (path: string, content: string) => path === '/etc/shadow' ? false : original(path, content);
    const vim = new VimEngine(fs, '/etc/shadow', 'root:!:19000:0:99999:7:::\n', false, 'vim');
    exCmd(vim, 'w');
    expect(vim.message).toBe(`E212: Can't open file for writing`);
  });
});

describe('Scénario UI-5 — indicateur [+] de modification en temps réel', () => {
  it('[+] doit apparaître immédiatement après une modification (état "modified")', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    expect(vim.modified).toBe(false);
    press(vim, 'A'); typeText(vim, 'z'); press(vim, 'Escape');
    expect(vim.modified).toBe(true);
  });

  it('[+] doit disparaître immédiatement après :w (état "modified" retombe à false)', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    press(vim, 'A'); typeText(vim, 'z'); press(vim, 'Escape');
    expect(vim.modified).toBe(true);
    exCmd(vim, 'w');
    expect(vim.modified).toBe(false);
  });
});

/**
 * Scénario 8 — Récupération depuis un fichier swap vim après
 * interruption : détection du swap, avertissement E325, récupération
 * interactive (O/E/R/Q/A), et nettoyage manuel requis après récupération.
 *
 * TDD: written against the intended real behaviour of VimEngine's swap
 * lifecycle. "kill -9" is modelled exactly as it is in reality for our
 * headless engine: simply abandoning the object without ever reaching
 * :q/:wq — nothing special to simulate, the swap file is just never
 * cleaned up, which is the whole point of the mechanism.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { dotSwapPathFor } from '@/network/devices/linux/editors/editorPaths';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}

const PATH = '/tmp/vim-swap-test.txt';
const SWAP_PATH = dotSwapPathFor(PATH);
const ORIGINAL = 'Contenu original\nLigne 2 originale\n';

describe('Scénario 8 — création du swap et interruption brutale', () => {
  it('vim crée le fichier swap dès l\'ouverture', () => {
    const fs = new InMemoryEditorFsContext({ [PATH]: ORIGINAL });
    const vim = new VimEngine(fs, PATH, ORIGINAL, false, 'vim');
    expect(vim.swapFileExists).toBe(true);
    expect(vim.swapFilePath).toBe(SWAP_PATH);
    expect(fs.exists(SWAP_PATH)).toBe(true);
  });

  it('après kill -9 (abandon sans :q), le fichier original est intact et le swap subsiste avec les modifications non sauvegardées', () => {
    const fs = new InMemoryEditorFsContext({ [PATH]: ORIGINAL });
    const vim = new VimEngine(fs, PATH, ORIGINAL, false, 'vim');

    press(vim, 'A');
    typeText(vim, ' MODIFIE');
    press(vim, 'Escape');
    expect(vim.modified).toBe(true);

    // "kill -9": no :q, no :w — just stop driving the engine.
    expect(fs.readFile(PATH)).toBe(ORIGINAL); // untouched on disk
    expect(fs.exists(SWAP_PATH)).toBe(true); // swap survives the "crash"

    const swapMeta = JSON.parse(fs.readFile(SWAP_PATH)!);
    expect(swapMeta.lines[0]).toBe('Contenu original MODIFIE');
  });
});

describe('Scénario 8 — récupération interactive (E325)', () => {
  let fs: InMemoryEditorFsContext;

  beforeEach(() => {
    fs = new InMemoryEditorFsContext({ [PATH]: ORIGINAL });
    fs.writeFile(SWAP_PATH, JSON.stringify({
      owner: 'user',
      filePath: PATH,
      lines: ['Contenu original MODIFIE', 'Ligne 2 originale'],
    }));
  });

  it('la réouverture détecte le swap et propose O/E/R/Q/A', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    expect(vim.mode).toBe('swap-recovery');
    expect(vim.pendingSwapRecovery).toEqual({
      swapPath: SWAP_PATH,
      filePath: PATH,
      ownedBySameUser: true,
      swapOwner: 'user',
    });
  });

  it('R restaure exactement le contenu non sauvegardé modifié avant l\'interruption', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    press(vim, 'R');
    expect(vim.mode).toBe('normal');
    expect(vim.lines).toEqual(['Contenu original MODIFIE', 'Ligne 2 originale']);
    expect(vim.modified).toBe(true); // recovered content differs from what's on disk
  });

  it('après R, le swap original devient orphelin (non supprimé) et une nouvelle session utilise .swo', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    press(vim, 'R');
    expect(vim.orphanSwapFilePath).toBe(SWAP_PATH);
    expect(vim.swapFilePath).toBe(SWAP_PATH.replace(/\.swp$/, '.swo'));
    expect(fs.exists(SWAP_PATH)).toBe(true);
    expect(fs.exists(vim.swapFilePath)).toBe(true);
  });

  it('après R, :wq puis :q laissent le swap orphelin nécessitant une suppression manuelle explicite', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    press(vim, 'R');
    const newSwap = vim.swapFilePath;

    press(vim, ':'); typeText(vim, 'wq'); press(vim, 'Enter');

    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(true);
    expect(fs.readFile(PATH)).toBe('Contenu original MODIFIE\nLigne 2 originale\n');
    expect(fs.exists(newSwap)).toBe(false); // this session's own swap is cleaned up
    expect(fs.exists(SWAP_PATH)).toBe(true); // the recovery-source .swp is NOT — matches real vim
  });

  it('E (edit anyway) ignore le contenu récupérable et édite le contenu du disque', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    press(vim, 'E');
    expect(vim.mode).toBe('normal');
    expect(vim.content + '\n').toBe(ORIGINAL); // disk content, not the swap's recovered lines
    expect(vim.orphanSwapFilePath).toBe(SWAP_PATH);
  });

  it('O (open read-only) édite le contenu du disque sans créer de nouveau swap, et refuse :w sans !', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    press(vim, 'O');
    expect(vim.mode).toBe('normal');
    expect(vim.isReadOnly).toBe(true);
    expect(vim.content + '\n').toBe(ORIGINAL);
    expect(vim.swapFileExists).toBe(false);

    press(vim, 'i'); typeText(vim, 'x'); press(vim, 'Escape');
    press(vim, ':'); typeText(vim, 'w'); press(vim, 'Enter');
    expect(vim.message).toContain('E45');
    expect(fs.readFile(PATH)).toBe(ORIGINAL); // write was refused

    press(vim, ':'); typeText(vim, 'w!'); press(vim, 'Enter');
    expect(fs.readFile(PATH)).not.toBe(ORIGINAL); // forced write succeeds
  });

  it('Q / A quittent sans ouvrir et sans toucher ni le fichier ni le swap existant', () => {
    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim');
    press(vim, 'Q');
    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(false);
    expect(fs.readFile(PATH)).toBe(ORIGINAL);
    expect(fs.exists(SWAP_PATH)).toBe(true);
  });
});

describe('Scénario 8 — cas particulier : swap appartenant à un autre utilisateur', () => {
  it('sans (R)ecover : seuls O, Q, A sont utilisables, R est refusé', () => {
    const fs = new InMemoryEditorFsContext({ [PATH]: ORIGINAL });
    fs.writeFile(SWAP_PATH, JSON.stringify({ owner: 'root', filePath: PATH, lines: ['modifié par root'] }));

    const vim = new VimEngine(fs, PATH, fs.readFile(PATH)!, false, 'vim', 'user');
    expect(vim.pendingSwapRecovery?.ownedBySameUser).toBe(false);
    expect(vim.pendingSwapRecovery?.swapOwner).toBe('root');

    // R is not offered for another user's swap — pressing it is a no-op.
    press(vim, 'R');
    expect(vim.mode).toBe('swap-recovery');

    // O still works.
    press(vim, 'O');
    expect(vim.mode).toBe('normal');
    expect(vim.isReadOnly).toBe(true);
  });
});

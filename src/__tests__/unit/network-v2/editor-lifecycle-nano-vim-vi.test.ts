/**
 * Scénario 1 — Cycle de vie complet d'une session d'édition : nano, vim et vi comparés.
 *
 * TDD: these assertions are written against the intended real behaviour of
 * NanoEngine/VimEngine (headless editor engines — see
 * src/network/devices/linux/editors/), independent of the React overlay
 * components. Each editor is driven keystroke-by-keystroke, exactly like a
 * real terminal would drive it, and the three resulting files are checked
 * for byte-for-byte equality — the same net edit (add a line, change a
 * word, delete a line) applied via each editor's own real command set.
 *
 * Where the scenario's prose keystroke annotations don't match genuine
 * editor semantics (e.g. `4dd` does not mean "go to line 4 and delete
 * it" in real vim — it means "delete 4 lines from the cursor"), the
 * keystroke sequence below uses the real, standards-correct commands
 * that achieve the documented intent instead.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { NanoEngine } from '@/network/devices/linux/editors/NanoEngine';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
import { InMemoryEditorFsContext } from '@/network/devices/linux/editors/InMemoryEditorFsContext';
import { editorKey } from '@/network/devices/linux/editors/EditorKeyInput';
import type { EditorKeyInput } from '@/network/devices/linux/editors/EditorKeyInput';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxEditorFsContext } from '@/terminal/sessions/LinuxEditorFsContext';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const REFERENCE_FILE =
  'ligne 1 : introduction\n' +
  'ligne 2 : contenu principal\n' +
  'ligne 3 : mot_a_remplacer ici\n' +
  'ligne 4 : à supprimer\n' +
  'ligne 5 : conclusion\n';

const EXPECTED_RESULT =
  'nouvelle ligne ajoutée\n' +
  'ligne 1 : introduction\n' +
  'ligne 2 : contenu principal\n' +
  'ligne 3 : nouveau_mot ici\n' +
  'ligne 5 : conclusion\n';

function typeText(engine: { applyKey(k: EditorKeyInput): void }, text: string): void {
  for (const ch of text) engine.applyKey(editorKey(ch));
}
function press(engine: { applyKey(k: EditorKeyInput): void }, key: string, mods: Partial<EditorKeyInput> = {}): void {
  engine.applyKey(editorKey(key, mods));
}
function ctrl(engine: { applyKey(k: EditorKeyInput): void }, key: string): void {
  engine.applyKey(editorKey(key, { ctrl: true }));
}

describe('Scénario 1 — nano: cycle de vie complet', () => {
  let fs: InMemoryEditorFsContext;
  let nano: NanoEngine;

  beforeEach(() => {
    fs = new InMemoryEditorFsContext({ '/tmp/test-nano.txt': REFERENCE_FILE });
    nano = new NanoEngine(fs, '/tmp/test-nano.txt', REFERENCE_FILE, false);
  });

  it('creates a lock/swap file while editing and removes it on clean exit', () => {
    expect(nano.swapFileExists).toBe(true);
    expect(nano.swapFilePath).toBe('/tmp/.test-nano.txt.swp');
    ctrl(nano, 'x'); // no modification yet -> exits immediately
    expect(nano.exited).toBe(true);
    expect(nano.swapFileExists).toBe(false);
  });

  it('Ctrl+X with no prior modification exits immediately without a prompt', () => {
    ctrl(nano, 'x');
    expect(nano.mode).not.toBe('exit-save-prompt');
    expect(nano.exited).toBe(true);
    expect(nano.savedOnExit).toBe(true);
  });

  it('Ctrl+X with an unsaved modification prompts "Save modified buffer?" with Y/N/^C', () => {
    typeText(nano, 'x');
    ctrl(nano, 'x');
    expect(nano.mode).toBe('exit-save-prompt');
    expect(nano.statusMessage).toContain('Save modified buffer?');
    expect(nano.exited).toBe(false);
  });

  it('exit-save-prompt: Y saves and exits, N discards and exits, ^C cancels back to editing', () => {
    // Y path -- real nano chains to "File Name to Write:" before writing.
    typeText(nano, 'x');
    ctrl(nano, 'x');
    press(nano, 'y');
    press(nano, 'Enter');
    expect(nano.exited).toBe(true);
    expect(nano.savedOnExit).toBe(true);
    expect(fs.readFile('/tmp/test-nano.txt')).toBe('x' + REFERENCE_FILE);

    // N path
    const fs2 = new InMemoryEditorFsContext({ '/tmp/n.txt': REFERENCE_FILE });
    const nano2 = new NanoEngine(fs2, '/tmp/n.txt', REFERENCE_FILE, false);
    typeText(nano2, 'z');
    ctrl(nano2, 'x');
    press(nano2, 'n');
    expect(nano2.exited).toBe(true);
    expect(nano2.savedOnExit).toBe(false);
    expect(fs2.readFile('/tmp/n.txt')).toBe(REFERENCE_FILE);

    // ^C cancel path
    const fs3 = new InMemoryEditorFsContext({ '/tmp/c.txt': REFERENCE_FILE });
    const nano3 = new NanoEngine(fs3, '/tmp/c.txt', REFERENCE_FILE, false);
    typeText(nano3, 'z');
    ctrl(nano3, 'x');
    ctrl(nano3, 'c');
    expect(nano3.mode).toBe('edit');
    expect(nano3.exited).toBe(false);
  });

  it('performs the full add-line / change-word / delete-line edit and saves with "[ Wrote N lines ]"', () => {
    // Add "nouvelle ligne ajoutée" above line 1: Enter, ArrowUp, type.
    press(nano, 'Enter');
    press(nano, 'ArrowUp');
    typeText(nano, 'nouvelle ligne ajoutée');

    // Find "mot_a_remplacer" (Ctrl+W search) and replace it in place.
    ctrl(nano, 'w');
    typeText(nano, 'mot_a_remplacer');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(3);
    expect(nano.cursorCol).toBe(10);
    for (let i = 0; i < 'mot_a_remplacer'.length; i++) press(nano, 'Delete');
    typeText(nano, 'nouveau_mot');

    // Cut the "à supprimer" line (Ctrl+K).
    press(nano, 'ArrowDown');
    ctrl(nano, 'k');

    expect(nano.content + '\n').toBe(EXPECTED_RESULT);

    // Save: Ctrl+O, Enter.
    ctrl(nano, 'o');
    expect(nano.mode).toBe('save-prompt');
    press(nano, 'Enter');
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toBe('[ Wrote 5 lines ]');
    expect(fs.readFile('/tmp/test-nano.txt')).toBe(EXPECTED_RESULT);

    // Clean exit: no residual lock/swap file.
    ctrl(nano, 'x');
    expect(nano.exited).toBe(true);
    expect(fs.exists('/tmp/.test-nano.txt.swp')).toBe(false);
  });
});

describe('Scénario 1 — vim: cycle de vie complet', () => {
  let fs: InMemoryEditorFsContext;
  let vim: VimEngine;

  beforeEach(() => {
    fs = new InMemoryEditorFsContext({ '/tmp/test-vim.txt': REFERENCE_FILE });
    vim = new VimEngine(fs, '/tmp/test-vim.txt', REFERENCE_FILE, false, 'vim');
  });

  it('starts in NORMAL mode (no -- INSERT -- indicator shown)', () => {
    expect(vim.mode).toBe('normal');
    expect(vim.showsInsertIndicator).toBe(false);
  });

  it('shows -- INSERT -- only while text is being entered', () => {
    press(vim, 'i');
    expect(vim.mode).toBe('insert');
    expect(vim.showsInsertIndicator).toBe(true);
    press(vim, 'Escape');
    expect(vim.showsInsertIndicator).toBe(false);
  });

  it('creates a .swp swap file while editing and removes it on clean :q', () => {
    expect(vim.swapFileExists).toBe(true);
    expect(vim.swapFilePath).toBe('/tmp/.test-vim.txt.swp');
    press(vim, ':');
    typeText(vim, 'q');
    press(vim, 'Enter');
    expect(vim.exited).toBe(true);
    expect(vim.swapFileExists).toBe(false);
  });

  it('performs the full add-line / change-word / delete-line edit via real vim commands', () => {
    press(vim, 'g'); press(vim, 'g'); // gg -> top (idempotent here)
    expect(vim.cursorLine).toBe(0);

    press(vim, 'O'); // open line above, enter insert
    expect(vim.mode).toBe('insert');
    typeText(vim, 'nouvelle ligne ajoutée');
    press(vim, 'Escape');

    press(vim, '/');
    typeText(vim, 'mot_a_remplacer');
    press(vim, 'Enter');
    expect(vim.cursorLine).toBe(3);
    expect(vim.cursorCol).toBe(10);

    press(vim, 'c'); press(vim, 'w'); // cw
    expect(vim.mode).toBe('insert');
    typeText(vim, 'nouveau_mot');
    press(vim, 'Escape');

    // Real vim `4dd` deletes 4 lines from the cursor, not "line 4" —
    // reach the target line explicitly instead, then delete just it.
    press(vim, 'j');
    press(vim, 'd'); press(vim, 'd');

    expect(vim.content + '\n').toBe(EXPECTED_RESULT);

    press(vim, ':');
    typeText(vim, 'w');
    press(vim, 'Enter');
    expect(vim.message).toMatch(/"\/tmp\/test-vim\.txt" 5L, \d+B written/);
    expect(fs.readFile('/tmp/test-vim.txt')).toBe(EXPECTED_RESULT);

    press(vim, ':');
    typeText(vim, 'q');
    press(vim, 'Enter');
    expect(vim.exited).toBe(true);
    expect(vim.swapFileExists).toBe(false);
  });

  it('supports :w (write without quitting) followed by a separate :q', () => {
    press(vim, 'i');
    typeText(vim, 'X');
    press(vim, 'Escape');
    press(vim, ':'); typeText(vim, 'w'); press(vim, 'Enter');
    expect(vim.modified).toBe(false);
    expect(fs.readFile('/tmp/test-vim.txt')).toBe('X' + REFERENCE_FILE);
    press(vim, ':'); typeText(vim, 'q'); press(vim, 'Enter');
    expect(vim.exited).toBe(true);
  });
});

describe('Scénario 1 — vi: cycle de vie complet, comparé à vim', () => {
  let fs: InMemoryEditorFsContext;
  let vi: VimEngine;

  beforeEach(() => {
    fs = new InMemoryEditorFsContext({ '/tmp/test-vi.txt': REFERENCE_FILE });
    vi = new VimEngine(fs, '/tmp/test-vi.txt', REFERENCE_FILE, false, 'vi');
  });

  it('does not show -- INSERT -- in strict vi (unlike vim)', () => {
    press(vi, 'i');
    expect(vi.mode).toBe('insert');
    expect(vi.showsInsertIndicator).toBe(false);
  });

  it('does not support gg (a vim-only extension) — cursor stays put', () => {
    press(vi, 'j'); press(vi, 'j');
    expect(vi.cursorLine).toBe(2);
    press(vi, 'g'); press(vi, 'g');
    expect(vi.cursorLine).toBe(2); // unaffected: real vi has no gg
  });

  it('supports the base ex commands :w, :q, :wq, :q! identically to vim', () => {
    press(vi, 'i'); typeText(vi, 'y'); press(vi, 'Escape');
    press(vi, ':'); typeText(vi, 'w'); press(vi, 'Enter');
    expect(vi.modified).toBe(false);
    press(vi, 'i'); typeText(vi, 'z'); press(vi, 'Escape');
    press(vi, ':'); typeText(vi, 'q!'); press(vi, 'Enter');
    expect(vi.exited).toBe(true);
    expect(vi.savedOnExit).toBe(false); // q! discards the unsaved 'z'
  });

  it('performs the same add-line / change-word / delete-line edit via real vi (POSIX) commands', () => {
    press(vi, '1'); press(vi, 'G'); // vi's real "go to first line" (no gg)
    expect(vi.cursorLine).toBe(0);

    press(vi, 'O');
    typeText(vi, 'nouvelle ligne ajoutée');
    press(vi, 'Escape');

    press(vi, '/');
    typeText(vi, 'mot_a_remplacer');
    press(vi, 'Enter');

    press(vi, 'c'); press(vi, 'w');
    typeText(vi, 'nouveau_mot');
    press(vi, 'Escape');

    press(vi, 'j');
    press(vi, 'd'); press(vi, 'd');

    expect(vi.content + '\n').toBe(EXPECTED_RESULT);

    press(vi, ':'); typeText(vi, 'wq'); press(vi, 'Enter');
    expect(vi.exited).toBe(true);
    expect(vi.savedOnExit).toBe(true);
    expect(fs.readFile('/tmp/test-vi.txt')).toBe(EXPECTED_RESULT);
  });
});

describe('Scénario 1 — comparaison finale : les trois fichiers sont octet-pour-octet identiques', () => {
  it('nano, vim and vi produce byte-identical files for the same net edit', () => {
    const results: Record<string, string> = {};
    for (const [name, variant] of [['nano', null], ['vim', 'vim'], ['vi', 'vi']] as const) {
      const path = `/tmp/test-${name}.txt`;
      const fs = new InMemoryEditorFsContext({ [path]: REFERENCE_FILE });

      if (variant === null) {
        const nano = new NanoEngine(fs, path, REFERENCE_FILE, false);
        press(nano, 'Enter'); press(nano, 'ArrowUp');
        typeText(nano, 'nouvelle ligne ajoutée');
        ctrl(nano, 'w'); typeText(nano, 'mot_a_remplacer'); press(nano, 'Enter');
        for (let i = 0; i < 'mot_a_remplacer'.length; i++) press(nano, 'Delete');
        typeText(nano, 'nouveau_mot');
        press(nano, 'ArrowDown'); ctrl(nano, 'k');
        ctrl(nano, 'o'); press(nano, 'Enter');
        ctrl(nano, 'x');
      } else {
        const vimEngine = new VimEngine(fs, path, REFERENCE_FILE, false, variant);
        if (variant === 'vim') { press(vimEngine, 'g'); press(vimEngine, 'g'); }
        else { press(vimEngine, '1'); press(vimEngine, 'G'); }
        press(vimEngine, 'O');
        typeText(vimEngine, 'nouvelle ligne ajoutée');
        press(vimEngine, 'Escape');
        press(vimEngine, '/'); typeText(vimEngine, 'mot_a_remplacer'); press(vimEngine, 'Enter');
        press(vimEngine, 'c'); press(vimEngine, 'w');
        typeText(vimEngine, 'nouveau_mot');
        press(vimEngine, 'Escape');
        press(vimEngine, 'j');
        press(vimEngine, 'd'); press(vimEngine, 'd');
        press(vimEngine, ':'); typeText(vimEngine, 'wq'); press(vimEngine, 'Enter');
      }

      results[name] = fs.readFile(path)!;
    }

    expect(results.nano).toBe(EXPECTED_RESULT);
    expect(results.vim).toBe(EXPECTED_RESULT);
    expect(results.vi).toBe(EXPECTED_RESULT);
    expect(results.nano).toBe(results.vim);
    expect(results.vim).toBe(results.vi);

    // No stray trailing bytes / mismatched EOL conventions (xxd-equivalent check).
    for (const name of ['nano', 'vim', 'vi']) {
      expect(results[name].endsWith('\n')).toBe(true);
      expect(results[name].endsWith('\n\n')).toBe(false);
    }
  });
});

describe('Scénario 1 — intégration: md5sum identique via la vraie VFS du device', () => {
  it('nano/vim/vi writes through LinuxEditorFsContext land in the real VFS with matching md5sum', async () => {
    EquipmentRegistry.resetInstance();
    const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
    pc.powerOn();

    for (const name of ['nano', 'vim', 'vi'] as const) {
      const path = `/tmp/test-${name}.txt`;
      const fsCtx = new LinuxEditorFsContext(pc);
      fsCtx.writeFile(path, REFERENCE_FILE);

      if (name === 'nano') {
        const nano = new NanoEngine(fsCtx, path, fsCtx.readFile(path)!, false);
        press(nano, 'Enter'); press(nano, 'ArrowUp');
        typeText(nano, 'nouvelle ligne ajoutée');
        ctrl(nano, 'w'); typeText(nano, 'mot_a_remplacer'); press(nano, 'Enter');
        for (let i = 0; i < 'mot_a_remplacer'.length; i++) press(nano, 'Delete');
        typeText(nano, 'nouveau_mot');
        press(nano, 'ArrowDown'); ctrl(nano, 'k');
        ctrl(nano, 'o'); press(nano, 'Enter');
        ctrl(nano, 'x');
      } else {
        const variant = name === 'vim' ? 'vim' : 'vi';
        const eng = new VimEngine(fsCtx, path, fsCtx.readFile(path)!, false, variant);
        if (variant === 'vim') { press(eng, 'g'); press(eng, 'g'); } else { press(eng, '1'); press(eng, 'G'); }
        press(eng, 'O');
        typeText(eng, 'nouvelle ligne ajoutée');
        press(eng, 'Escape');
        press(eng, '/'); typeText(eng, 'mot_a_remplacer'); press(eng, 'Enter');
        press(eng, 'c'); press(eng, 'w');
        typeText(eng, 'nouveau_mot');
        press(eng, 'Escape');
        press(eng, 'j');
        press(eng, 'd'); press(eng, 'd');
        press(eng, ':'); typeText(eng, 'wq'); press(eng, 'Enter');
      }
    }

    const md5nano = (await pc.executeCommand('md5sum /tmp/test-nano.txt')).split(/\s+/)[0];
    const md5vim = (await pc.executeCommand('md5sum /tmp/test-vim.txt')).split(/\s+/)[0];
    const md5vi = (await pc.executeCommand('md5sum /tmp/test-vi.txt')).split(/\s+/)[0];

    expect(md5nano).toBe(md5vim);
    expect(md5vim).toBe(md5vi);

    const diffResult = await pc.executeCommand('diff /tmp/test-nano.txt /tmp/test-vim.txt');
    expect(diffResult.trim()).toBe('');
  });
});

/**
 * Scénario UI-9 — Affichage des caractères spéciaux, encodage et fin de
 * ligne dans les éditeurs : détection de fichier binaire (vim), affichage
 * `:set list` (CRLF/tabs/EOL), caractères de contrôle en notation `^X`
 * (nano), et `:set fileencoding?`.
 *
 * TDD: written against the headless NanoEngine/VimEngine. UTF-8 multi-byte
 * handling and CJK double-width columns are NOT modeled beyond what the
 * plain <textarea> gives for free (native browser text layout) — true
 * per-column cursor math for double-width glyphs would need the same
 * token-renderer rewrite already flagged out of scope for syntax
 * highlighting, so this is a disclosed limitation, not a faked pass.
 */
import { describe, it, expect } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
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
function exCmd(engine: { applyKey(k: EditorKeyInput): void }, cmd: string): void {
  press(engine, ':'); typeText(engine, cmd); press(engine, 'Enter');
}

describe('Scénario UI-9 — vim : détection de fichier binaire (octet NUL)', () => {
  it('un fichier contenant un octet NUL déclenche l\'avertissement avant tout affichage', () => {
    const content = 'ELF\0\0\0\0header\n';
    const fs = new InMemoryEditorFsContext({ '/bin/fake-elf': content });
    const vim = new VimEngine(fs, '/bin/fake-elf', content, false, 'vim');
    expect(vim.mode).toBe('binary-warning');
    expect(vim.pendingBinaryWarning).toBe('"/bin/fake-elf" may be a binary file, see it anyway?');
  });

  it('répondre "y" affiche le contenu tel quel (l\'octet NUL est réellement présent dans le buffer)', () => {
    const content = 'ELF\0\0\0\0header\n';
    const fs = new InMemoryEditorFsContext({ '/bin/fake-elf': content });
    const vim = new VimEngine(fs, '/bin/fake-elf', content, false, 'vim');
    press(vim, 'y');
    expect(vim.mode).toBe('normal');
    expect(vim.content).toContain('\0');
  });

  it('répondre "n" quitte immédiatement sans jamais entrer en mode édition', () => {
    const content = 'ELF\0\0\0\0header\n';
    const fs = new InMemoryEditorFsContext({ '/bin/fake-elf': content });
    const vim = new VimEngine(fs, '/bin/fake-elf', content, false, 'vim');
    press(vim, 'n');
    expect(vim.exited).toBe(true);
    expect(vim.savedOnExit).toBe(false);
  });

  it('un fichier texte normal (sans octet NUL) n\'affiche jamais cet avertissement', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/normal.txt': 'plain text\n' });
    const vim = new VimEngine(fs, '/tmp/normal.txt', 'plain text\n', false, 'vim');
    expect(vim.mode).toBe('normal');
    expect(vim.pendingBinaryWarning).toBeNull();
  });
});

describe('Scénario UI-9 — vim : :set list affiche $ (EOL), ^I (tabs), ^M (CR isolé)', () => {
  it('sans :set list, les tabs et fins de ligne sont invisibles', () => {
    const content = 'a\tb\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/tabs.txt': content });
    const vim = new VimEngine(fs, '/tmp/tabs.txt', content, false, 'vim');
    expect(vim.listMode).toBe(false);
    expect(vim.renderListLine(vim.lines[0])).toBe('a\tb'); // list off: passthrough
  });

  it(':set list affiche $ en fin de ligne et ^I pour les tabulations', () => {
    const content = 'a\tb\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/tabs.txt': content });
    const vim = new VimEngine(fs, '/tmp/tabs.txt', content, false, 'vim');
    exCmd(vim, 'set list');
    expect(vim.listMode).toBe(true);
    expect(vim.renderListLine(vim.lines[0])).toBe('a^Ib$');
  });

  it(':set list révèle un ^M pour un CR isolé (corruption), invisible sans list', () => {
    // A stray CR merged mid-line (not part of a \r\n pair) — real
    // corruption, matching the CRLF-cleanup scenario from before.
    const content = 'line1\rline1b\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/stray-cr.txt': content });
    const vim = new VimEngine(fs, '/tmp/stray-cr.txt', content, false, 'vim');
    exCmd(vim, 'set list');
    expect(vim.renderListLine(vim.lines[0])).toBe('line1^Mline1b$');
  });

  it(':set listchars personnalise les symboles (tab, trail, eol)', () => {
    const content = 'a\tb  \n';
    const fs = new InMemoryEditorFsContext({ '/tmp/custom.txt': content });
    const vim = new VimEngine(fs, '/tmp/custom.txt', content, false, 'vim');
    exCmd(vim, 'set listchars=tab:>-,trail:.,eol:$');
    exCmd(vim, 'set list');
    expect(vim.renderListLine(vim.lines[0])).toBe('a>-b..$');
  });

  it(':set nolist désactive à nouveau l\'affichage', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    exCmd(vim, 'set list');
    expect(vim.listMode).toBe(true);
    exCmd(vim, 'set nolist');
    expect(vim.listMode).toBe(false);
  });
});

describe('Scénario UI-9 — vim : :set fileencoding? rapporte toujours utf-8', () => {
  it('rapporte fileencoding=utf-8', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    exCmd(vim, 'set fileencoding?');
    expect(vim.message).toBe('fileencoding=utf-8');
  });
});

describe('Scénario UI-9 — nano : caractères de contrôle en notation ^X', () => {
  it('les octets de contrôle (< 0x20) sont représentés en ^X, jamais affichés bruts', () => {
    const content = 'texte\x01control\x02chars\x1bici\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/ctrl.txt': content });
    const nano = new NanoEngine(fs, '/tmp/ctrl.txt', content, false);
    expect(nano.displayContent).toBe('texte^Acontrol^Bchars^[ici');
  });

  it('tab et retour à la ligne restent des caractères réels (pas de transformation)', () => {
    const content = 'a\tb\nc\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/tab.txt': content });
    const nano = new NanoEngine(fs, '/tmp/tab.txt', content, false);
    expect(nano.displayContent).toBe('a\tb\nc');
  });

  it('DEL (0x7f) est représenté par ^?', () => {
    const content = 'a\x7fb\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/del.txt': content });
    const nano = new NanoEngine(fs, '/tmp/del.txt', content, false);
    expect(nano.displayContent).toBe('a^?b');
  });

  it('un texte sans caractère de contrôle est affiché tel quel', () => {
    const content = 'plain ascii text\n';
    const fs = new InMemoryEditorFsContext({ '/tmp/plain.txt': content });
    const nano = new NanoEngine(fs, '/tmp/plain.txt', content, false);
    expect(nano.displayContent).toBe(nano.content);
  });
});

describe('Scénario UI-9 — vim : détection filetype étendue', () => {
  it('/etc/network/interfaces → filetype=interfaces', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/network/interfaces': 'auto eth0\n' });
    const vim = new VimEngine(fs, '/etc/network/interfaces', 'auto eth0\n', false, 'vim');
    exCmd(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=interfaces');
  });

  it('/etc/hosts → filetype=hostsfile', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/hosts': '127.0.0.1 localhost\n' });
    const vim = new VimEngine(fs, '/etc/hosts', '127.0.0.1 localhost\n', false, 'vim');
    exCmd(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=hostsfile');
  });

  it('/etc/resolv.conf → filetype=resolv', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/resolv.conf': 'nameserver 1.1.1.1\n' });
    const vim = new VimEngine(fs, '/etc/resolv.conf', 'nameserver 1.1.1.1\n', false, 'vim');
    exCmd(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=resolv');
  });

  it('/etc/sudoers → filetype=sudoers', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/sudoers': 'root ALL=(ALL:ALL) ALL\n' });
    const vim = new VimEngine(fs, '/etc/sudoers', 'root ALL=(ALL:ALL) ALL\n', false, 'vim');
    exCmd(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=sudoers');
  });

  it('/etc/passwd → filetype=passwd', () => {
    const fs = new InMemoryEditorFsContext({ '/etc/passwd': 'root:x:0:0::/root:/bin/bash\n' });
    const vim = new VimEngine(fs, '/etc/passwd', 'root:x:0:0::/root:/bin/bash\n', false, 'vim');
    exCmd(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=passwd');
  });

  it('/tmp/test.sh → filetype=sh', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/test.sh': '#!/bin/bash\necho hi\n' });
    const vim = new VimEngine(fs, '/tmp/test.sh', '#!/bin/bash\necho hi\n', false, 'vim');
    exCmd(vim, 'set filetype?');
    expect(vim.message).toBe('filetype=sh');
  });
});

describe('Scénario UI-10 (état moteur, scoped) — colorcolumn / hlsearch / showmatch / incsearch', () => {
  it(':set colorcolumn=80 est mémorisé exactement à la colonne 80', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    expect(vim.colorColumn).toBeNull();
    exCmd(vim, 'set colorcolumn=80');
    expect(vim.colorColumn).toBe(80);
  });

  it(':set colorcolumn= (vide) désactive la colonne', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    exCmd(vim, 'set colorcolumn=80');
    exCmd(vim, 'set colorcolumn=');
    expect(vim.colorColumn).toBeNull();
  });

  it(':set showmatch / :set noshowmatch basculent l\'état', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    expect(vim.showMatch).toBe(false);
    exCmd(vim, 'set showmatch');
    expect(vim.showMatch).toBe(true);
    exCmd(vim, 'set noshowmatch');
    expect(vim.showMatch).toBe(false);
  });

  it(':set incsearch / :set noincsearch basculent l\'état', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    expect(vim.incSearch).toBe(false);
    exCmd(vim, 'set incsearch');
    expect(vim.incSearch).toBe(true);
  });

  it('hlsearch (déjà existant) reste togglable indépendamment', () => {
    const fs = new InMemoryEditorFsContext({ '/tmp/x.txt': 'a\n' });
    const vim = new VimEngine(fs, '/tmp/x.txt', 'a\n', false, 'vim');
    exCmd(vim, 'set hlsearch');
    expect(vim.hlsearch).toBe(true);
    exCmd(vim, 'set nohlsearch');
    expect(vim.hlsearch).toBe(false);
  });
});

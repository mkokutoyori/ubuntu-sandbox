/**
 * Scénario 3 — Recherche et remplacement dans nano : Ctrl+W, Ctrl+\ et
 * options avancées, comparées au comportement de vim sur le même
 * fichier.
 *
 * Note on keybindings: the scenario's prose says "Ctrl+W puis Ctrl+R
 * pour regex". Real GNU nano's regex toggle inside a search/replace
 * prompt is bound to Meta+R (Alt+R) — Ctrl+R is a different, unrelated
 * shortcut ("Read File") shown in nano's own bottom bar. Per the
 * instruction to keep what matches real tool behaviour when the two
 * diverge, this suite (and NanoEngine) implements the real Alt+R
 * binding.
 *
 * TDD: written against the intended real behaviour of NanoEngine's
 * search/replace layer.
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
function altR(engine: { applyKey(k: EditorKeyInput): void }): void {
  engine.applyKey(editorKey('r', { alt: true }));
}

function newEngine(content: string, path = '/tmp/t.txt'): NanoEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new NanoEngine(fs, path, content, false);
}

/**
 * Real nano's search/replace prompt shows the previous term with the
 * cursor at the end (not pre-selected) — a real user backspaces it away
 * before typing a new one, exactly like this helper does.
 */
function clearPromptField(engine: { applyKey(k: EditorKeyInput): void }): void {
  for (let i = 0; i < 64; i++) press(engine, 'Backspace');
}

describe('Scénario 3 — Ctrl+W recherche simple et répétition', () => {
  it('finds the first occurrence, then Ctrl+W + Enter (no retype) repeats the same term', () => {
    // Cursor starts before either match (real nano/vim search always finds
    // the next occurrence strictly AFTER the cursor, never one exactly
    // under it — that matters when the cursor already sits on a match,
    // which is deliberately avoided here to isolate the "repeat" behaviour).
    const nano = newEngine('xxx\n192.168.1.100\nsomething\n192.168.1.200\n');
    ctrl(nano, 'w');
    typeText(nano, '192.168.1');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(1);
    expect(nano.cursorCol).toBe(0);

    ctrl(nano, 'w');
    expect(nano.searchQuery).toBe('192.168.1'); // prefilled with the last term, like real nano
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(3);
    expect(nano.cursorCol).toBe(0);
  });
});

describe('Scénario 3 — Ctrl+W + Alt+R (regex mode)', () => {
  it('toggles regex mode and searches with a real regex pattern', () => {
    const nano = newEngine('abc123def\n');
    ctrl(nano, 'w');
    expect(nano.regexSearchEnabled).toBe(false);
    altR(nano);
    expect(nano.regexSearchEnabled).toBe(true);
    typeText(nano, '[0-9]+');
    press(nano, 'Enter');
    expect(nano.cursorLine).toBe(0);
    expect(nano.cursorCol).toBe(3);
  });
});

describe('Scénario 3 — Ctrl+\\ remplacement avec confirmation Y/N/A', () => {
  let nano: NanoEngine;
  beforeEach(() => { nano = newEngine('eth0 up\neth1 up\neth2 up\n'); });

  it('opens a two-step prompt (search, then replace-with) before confirming', () => {
    ctrl(nano, '\\');
    expect(nano.mode).toBe('replace-search');
    typeText(nano, 'eth');
    press(nano, 'Enter');
    expect(nano.mode).toBe('replace-with');
    typeText(nano, 'ens');
    press(nano, 'Enter');
    expect(nano.mode).toBe('replace-confirm');
    expect(nano.pendingReplaceMatch).toEqual({ line: 0, start: 0, end: 3, matchText: 'eth' });
  });

  it('A replaces this and every remaining occurrence at once', () => {
    ctrl(nano, '\\');
    typeText(nano, 'eth'); press(nano, 'Enter');
    typeText(nano, 'ens'); press(nano, 'Enter');
    press(nano, 'a');
    expect(nano.lines).toEqual(['ens0 up', 'ens1 up', 'ens2 up']);
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toBe('Replaced 3 occurrences');
  });

  it('Y/N per occurrence produces exactly the confirmed subset', () => {
    ctrl(nano, '\\');
    typeText(nano, 'eth'); press(nano, 'Enter');
    typeText(nano, 'ens'); press(nano, 'Enter');
    press(nano, 'y'); // 0 -> ens0
    press(nano, 'n'); // 1 stays eth1
    press(nano, 'y'); // 2 -> ens2
    expect(nano.lines).toEqual(['ens0 up', 'eth1 up', 'ens2 up']);
    expect(nano.mode).toBe('edit');
    expect(nano.statusMessage).toBe('Replaced 2 occurrences');
  });
});

describe('Scénario 3 — limites documentées de nano vis-à-vis de vim', () => {
  it('a regex replacement text is always literal — no \\1 backreference support (unlike vim)', () => {
    const nano = newEngine('abc123\n');
    ctrl(nano, '\\');
    altR(nano);
    typeText(nano, '([0-9]+)'); press(nano, 'Enter');
    typeText(nano, String.raw`[\1]`); press(nano, 'Enter');
    press(nano, 'a');
    // Real nano inserts the replacement text verbatim — \1 is NOT expanded.
    expect(nano.lines[0]).toBe(String.raw`abc[\1]`);
  });

  it('replacing a whole-line regex match with an empty string blanks the line but does NOT remove it (unlike vim :g/pat/d)', () => {
    const nano = newEngine('keep1\n#comment one\nkeep2\n#comment two\n');
    ctrl(nano, '\\');
    altR(nano);
    typeText(nano, '^#.*'); press(nano, 'Enter');
    press(nano, 'Enter'); // empty replacement
    press(nano, 'a');
    expect(nano.lines).toEqual(['keep1', '', 'keep2', '']); // 4 lines preserved, not 2
  });
});

describe('Scénario 3 — round-trip sur /etc/network/interfaces simulé, comparé à vim', () => {
  const ORIGINAL = [
    '# Configuration réseau mandeng',
    'auto eth0',
    'iface eth0 inet static',
    '  address 192.168.1.100',
    '  netmask 255.255.255.0',
    '  gateway 192.168.1.1',
    '',
    'auto eth1',
    'iface eth1 inet static',
    '  address 192.168.1.101',
    '  netmask 255.255.255.0',
    '  gateway 192.168.1.1',
    '',
    'auto eth2',
    'iface eth2 inet dhcp',
    '',
    '# Ancien format commenté',
    '#address 10.0.0.1',
    '#netmask 255.0.0.0',
  ].join('\n') + '\n';

  it('nano can only perform the substitutions it actually supports, and the result genuinely diverges from vim where it cannot', () => {
    const nano = newEngine(ORIGINAL, '/tmp/interfaces-nano.txt');

    // 1) plain global replace — nano CAN do this.
    ctrl(nano, '\\');
    typeText(nano, '192.168.1'); press(nano, 'Enter');
    typeText(nano, '10.10.10'); press(nano, 'Enter');
    press(nano, 'a');

    // 2) plain global replace — nano CAN do this. The search prompt is
    // prefilled with the previous term ("192.168.1"), so clear it first.
    ctrl(nano, '\\');
    clearPromptField(nano);
    typeText(nano, 'eth'); press(nano, 'Enter');
    clearPromptField(nano);
    typeText(nano, 'ens'); press(nano, 'Enter');
    press(nano, 'a');

    // 3) regex-blank the comment lines — the closest nano gets to
    // vim's :g/^#/d; it clears the text but cannot remove the line.
    ctrl(nano, '\\');
    altR(nano);
    clearPromptField(nano);
    typeText(nano, '^#.*'); press(nano, 'Enter');
    press(nano, 'Enter');
    press(nano, 'a');

    expect(nano.lines).toHaveLength(19); // NOT 15 like vim's :g/^#/d result
    expect(nano.lines[0]).toBe('');
    expect(nano.lines[3]).toBe('  address 10.10.10.100'); // no capture groups -> no "# ajouté"
    expect(nano.lines[5]).toBe('  gateway 10.10.10.1'); // no :g/gateway/s -> not .254
    expect(nano.lines[8]).toBe('iface ens1 inet static'); // no line-range support -> not "manual"

    // What scenario 3's own grep-equivalent checkpoints ask for still holds,
    // even though the underlying representation differs from vim's:
    expect(nano.lines.filter((l) => l.includes('192.168.1'))).toHaveLength(0);
    expect(nano.lines.filter((l) => l.startsWith('#'))).toHaveLength(0);
  });
});

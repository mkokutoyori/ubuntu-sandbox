/**
 * Scénario 2 — Recherche et remplacement global avec expressions
 * régulières dans vim : substitution globale, confirmation interactive,
 * groupes de capture, plages de lignes, commande globale :g.
 *
 * TDD: written against the intended real behaviour of VimEngine's ex
 * command layer (:s, :g, ranges, vim "magic mode" regex translation).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VimEngine } from '@/network/devices/linux/editors/VimEngine';
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
  press(engine, ':');
  typeText(engine, cmd);
  press(engine, 'Enter');
}

function newEngine(content: string, path = '/tmp/t.txt'): VimEngine {
  const fs = new InMemoryEditorFsContext({ [path]: content });
  return new VimEngine(fs, path, content, false, 'vim');
}

describe('Scénario 2 — :%s substitution globale simple', () => {
  it('replaces every occurrence on every line and reports the count', () => {
    const vim = newEngine('192.168.1.100\n192.168.1.101\nno match here\n');
    exCmd(vim, '%s/192.168.1/10.10.10/g');
    expect(vim.lines).toEqual(['10.10.10.100', '10.10.10.101', 'no match here']);
    expect(vim.message).toMatch(/2 substitutions? on 2 lines?/);
  });

  it('without the g flag only replaces the first occurrence per line', () => {
    const vim = newEngine('aa aa aa\n');
    exCmd(vim, '%s/aa/bb/');
    expect(vim.lines[0]).toBe('bb aa aa');
  });

  it('with the g flag replaces every occurrence on the line', () => {
    const vim = newEngine('aa aa aa\n');
    exCmd(vim, '%s/aa/bb/g');
    expect(vim.lines[0]).toBe('bb bb bb');
  });

  it('reports E486 when the pattern is not found', () => {
    const vim = newEngine('hello\n');
    exCmd(vim, '%s/zzz/yyy/g');
    expect(vim.message).toContain('E486');
    expect(vim.lines[0]).toBe('hello');
  });
});

describe('Scénario 2 — groupes de capture \\( \\) et rétro-références \\1 \\2', () => {
  it('captures sub-groups and reuses them in the replacement', () => {
    const vim = newEngine('  address 10.10.10.100\n  address 10.10.10.101\n  gateway 10.10.10.1\n');
    exCmd(vim, String.raw`%s/address \(10\.10\.10\.\)\([0-9]*\)/address \1\2 # ajouté/g`);
    expect(vim.lines[0]).toBe('  address 10.10.10.100 # ajouté');
    expect(vim.lines[1]).toBe('  address 10.10.10.101 # ajouté');
    expect(vim.lines[2]).toBe('  gateway 10.10.10.1'); // untouched: no "address" on this line
  });

  it('treats unescaped ( ) as LITERAL characters (real vim magic-mode semantics)', () => {
    // Real vim default 'magic' mode: unescaped ( is a literal paren, not a group.
    const vim = newEngine('a(b)c\n');
    exCmd(vim, String.raw`%s/a(b)c/MATCHED/g`);
    expect(vim.lines[0]).toBe('MATCHED');
  });
});

describe('Scénario 2 — plage de lignes :N,Ms', () => {
  it('only substitutes within the given 1-indexed line range', () => {
    const vim = newEngine('static\nstatic\nstatic\nstatic\n');
    exCmd(vim, '2,3s/static/manual/g');
    expect(vim.lines).toEqual(['static', 'manual', 'manual', 'static']);
  });
});

describe('Scénario 2 — commande globale :g/pattern/cmd', () => {
  it(':g/pattern/d deletes every matching line, unaffected by shifting indices', () => {
    const vim = newEngine('#one\nkeep1\n#two\nkeep2\n#three\n');
    exCmd(vim, 'g/^#/d');
    expect(vim.lines).toEqual(['keep1', 'keep2']);
  });

  it(':g/pattern/s/.../.../  runs the substitution only on matching lines', () => {
    const vim = newEngine('gateway 10.10.10.1\naddress 10.10.10.1\ngateway 10.10.10.1\n');
    exCmd(vim, String.raw`g/gateway/s/10\.10\.10\.1/10.10.10.254/g`);
    expect(vim.lines).toEqual(['gateway 10.10.10.254', 'address 10.10.10.1', 'gateway 10.10.10.254']);
  });

  it(':g defaults to the whole file when no range is given', () => {
    const vim = newEngine('x\nfoo\nx\nfoo\n');
    press(vim, 'G'); // move cursor away from line 1 first
    exCmd(vim, 'g/foo/d');
    expect(vim.lines).toEqual(['x', 'x']);
  });
});

describe('Scénario 2 — remplacement avec confirmation interactive (flag c)', () => {
  let vim: VimEngine;
  beforeEach(() => { vim = newEngine('eth0 up\neth1 up\neth2 up\n'); });

  it('prompts for the first match and pauses in confirm-substitute mode', () => {
    exCmd(vim, '%s/eth/ens/gc');
    expect(vim.mode).toBe('confirm-substitute');
    expect(vim.pendingSubstMatch).not.toBeNull();
    expect(vim.pendingSubstMatch!.line).toBe(0);
    expect(vim.pendingSubstMatch!.matchText).toBe('eth');
    expect(vim.pendingSubstMatch!.replacementPreview).toBe('ens');
    expect(vim.lines[0]).toBe('eth0 up'); // not applied until confirmed
  });

  it('y replaces this match and advances to the next one', () => {
    exCmd(vim, '%s/eth/ens/gc');
    press(vim, 'y');
    expect(vim.lines[0]).toBe('ens0 up');
    expect(vim.mode).toBe('confirm-substitute');
    expect(vim.pendingSubstMatch!.line).toBe(1);
  });

  it('n skips this match, leaves it unchanged, and advances', () => {
    exCmd(vim, '%s/eth/ens/gc');
    press(vim, 'n');
    expect(vim.lines[0]).toBe('eth0 up');
    expect(vim.mode).toBe('confirm-substitute');
    expect(vim.pendingSubstMatch!.line).toBe(1);
  });

  it('a replaces this and every remaining match without further prompts', () => {
    exCmd(vim, '%s/eth/ens/gc');
    press(vim, 'a');
    expect(vim.lines).toEqual(['ens0 up', 'ens1 up', 'ens2 up']);
    expect(vim.mode).toBe('normal');
  });

  it('q aborts, leaving the current and all remaining matches unchanged', () => {
    exCmd(vim, '%s/eth/ens/gc');
    press(vim, 'y'); // line 0 -> ens0
    press(vim, 'q'); // abort before line 1
    expect(vim.lines).toEqual(['ens0 up', 'eth1 up', 'eth2 up']);
    expect(vim.mode).toBe('normal');
  });

  it('l replaces this match then stops, like a + immediate quit', () => {
    exCmd(vim, '%s/eth/ens/gc');
    press(vim, 'l');
    expect(vim.lines).toEqual(['ens0 up', 'eth1 up', 'eth2 up']);
    expect(vim.mode).toBe('normal');
  });

  it('mixed y/n/y produces exactly the confirmed subset', () => {
    exCmd(vim, '%s/eth/ens/gc');
    press(vim, 'y'); // 0 -> ens0
    press(vim, 'n'); // 1 stays eth1
    press(vim, 'y'); // 2 -> ens2
    expect(vim.lines).toEqual(['ens0 up', 'eth1 up', 'ens2 up']);
    expect(vim.mode).toBe('normal');
  });
});

describe('Scénario 2 — round-trip complet sur /etc/network/interfaces simulé', () => {
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

  const EXPECTED = [
    'auto ens0',
    'iface ens0 inet static',
    '  address 10.10.10.100 # ajouté',
    '  netmask 255.255.255.0',
    '  gateway 10.10.10.254',
    '',
    'auto ens1',
    'iface ens1 inet manual',
    '  address 10.10.10.101 # ajouté',
    '  netmask 255.255.255.0',
    '  gateway 10.10.10.254',
    '',
    'auto ens2',
    'iface ens2 inet dhcp',
    '',
  ];

  it('applies the full progressive substitution sequence and matches the hand-verified result', () => {
    const vim = newEngine(ORIGINAL, '/tmp/interfaces-vim.txt');

    exCmd(vim, '%s/192.168.1/10.10.10/g');
    expect(vim.lines.join('\n')).not.toContain('192.168.1');

    exCmd(vim, '%s/eth/ens/gc');
    expect(vim.mode).toBe('confirm-substitute');
    press(vim, 'a'); // replace all remaining eth -> ens
    expect(vim.mode).toBe('normal');

    exCmd(vim, String.raw`%s/address \(10\.10\.10\.\)\([0-9]*\)/address \1\2 # ajouté/g`);

    exCmd(vim, '5,10s/static/manual/g');

    exCmd(vim, String.raw`g/gateway/s/10\.10\.10\.1/10.10.10.254/g`);

    exCmd(vim, 'g/^#/d');

    expect(vim.lines).toEqual(EXPECTED);

    // grep-equivalent checkpoints from the scenario.
    expect(vim.lines.filter((l) => l.includes('192.168.1'))).toHaveLength(0);
    expect(vim.lines.filter((l) => l.startsWith('#'))).toHaveLength(0);
    expect(vim.lines.filter((l) => l.includes('static'))).toEqual(['iface ens0 inet static']);
  });
});

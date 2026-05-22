/**
 * Shell aliasing + the `command` builtin.
 *
 * Covers:
 *   AL-01  alias definition, listing, expansion and persistence
 *   AL-02  unalias (single / -a)
 *   AL-03  recursive + self-referential alias safety
 *   CM-01  `command` bypasses aliases
 *   CM-02  `command -v` / `-V` resolution
 *   TY-01  `type` reports aliases
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

// ═══════════════════════════════════════════════════════════════════════
// AL-01 — alias definition / listing / expansion
// ═══════════════════════════════════════════════════════════════════════

describe('AL-01 — alias definition and expansion', () => {
  it('a defined alias is expanded when used as a command', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias hi='echo hello world'");
    const out = await pc.executeCommand('hi');
    expect(out.trim()).toBe('hello world');
  });

  it('an alias persists across separate command invocations', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias g='echo aliased'");
    await pc.executeCommand('echo unrelated');
    const out = await pc.executeCommand('g');
    expect(out.trim()).toBe('aliased');
  });

  it('alias arguments are appended after the expansion', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias e='echo prefix'");
    const out = await pc.executeCommand('e suffix');
    expect(out.trim()).toBe('prefix suffix');
  });

  it('`alias` with no operands lists every definition', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias a='echo 1'");
    await pc.executeCommand("alias b='echo 2'");
    const out = await pc.executeCommand('alias');
    expect(out).toContain("alias a='echo 1'");
    expect(out).toContain("alias b='echo 2'");
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AL-02 — unalias
// ═══════════════════════════════════════════════════════════════════════

describe('AL-02 — unalias', () => {
  it('unalias removes a single alias', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias x='echo gone'");
    await pc.executeCommand('unalias x');
    const out = await pc.executeCommand('x');
    expect(out).toMatch(/command not found/);
  });

  it('unalias -a clears every alias', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias p='echo 1'");
    await pc.executeCommand("alias q='echo 2'");
    await pc.executeCommand('unalias -a');
    const out = await pc.executeCommand('alias');
    expect(out.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// AL-03 — recursion safety
// ═══════════════════════════════════════════════════════════════════════

describe('AL-03 — recursion safety', () => {
  it('a self-referential alias terminates instead of looping', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    // The point is that expansion must not loop forever.
    await pc.executeCommand("alias echo='echo'");
    const out = await pc.executeCommand('echo finished');
    expect(out.trim()).toBe('finished');
  });

  it('chained aliases expand transitively', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias one='echo final'");
    await pc.executeCommand("alias two='one'");
    const out = await pc.executeCommand('two');
    expect(out.trim()).toBe('final');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// CM-01 / CM-02 — the `command` builtin
// ═══════════════════════════════════════════════════════════════════════

describe('CM-01 — command bypasses aliases', () => {
  it('`command` runs the real command, not the alias', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias echo='echo aliased:'");
    const viaAlias = await pc.executeCommand('echo hi');
    expect(viaAlias.trim()).toBe('aliased: hi');
    const viaCommand = await pc.executeCommand('command echo hi');
    expect(viaCommand.trim()).toBe('hi');
  });
});

describe('CM-02 — command -v / -V', () => {
  it('command -v resolves a builtin to its name', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('command -v echo');
    expect(out.trim()).toBe('echo');
  });

  it('command -v resolves an external command to a path', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('command -v ls');
    expect(out.trim()).toBe('/usr/bin/ls');
  });

  it('command -V is verbose for a builtin', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    const out = await pc.executeCommand('command -V echo');
    expect(out).toContain('echo is a shell builtin');
  });
});

// ═══════════════════════════════════════════════════════════════════════
// TY-01 — type is alias-aware
// ═══════════════════════════════════════════════════════════════════════

describe('TY-01 — type reports aliases', () => {
  it('type shows an alias definition', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias ll='ls -la'");
    const out = await pc.executeCommand('type ll');
    expect(out).toMatch(/ll is aliased to .ls -la./);
  });

  it('type -t prints the one-word kind', async () => {
    const pc = new LinuxPC('linux-pc', 'PC1');
    await pc.executeCommand("alias ll='ls -la'");
    expect((await pc.executeCommand('type -t ll')).trim()).toBe('alias');
    expect((await pc.executeCommand('type -t echo')).trim()).toBe('builtin');
  });
});

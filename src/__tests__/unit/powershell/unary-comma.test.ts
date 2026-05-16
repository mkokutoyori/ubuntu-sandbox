/**
 * Regression — the unary comma (single-element array) operator.
 *
 * Surfaced by the new per-cmdlet attribute debug suites
 * (foreach-object: `1..3 | ForEach-Object { ,@($_, $_*2) }`).
 * Before the fix `,expr` at statement / scriptblock-body start was
 * dispatched as a command named "," ("not recognized"), and
 * `$a = ,5` mis-parsed to a 2-element array.
 *
 * `,expr` must be a SINGLE-element array wrapping expr — even when
 * expr is itself an array (`(,@(1,2,3)).Count` is 1, not 3).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function sh() {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
const run = async (s: ReturnType<typeof sh>, l: string) =>
  (await s.processLine(l)).output.join('\n');

describe('unary comma operator', () => {
  it('`,1` is a 1-element array (no "not recognized")', async () => {
    const out = await run(sh(), ',1');
    expect(out).not.toMatch(/not recognized/i);
    expect(out.trim()).toBe('1');
  });

  it('`(,1).Count` is 1', async () => {
    expect((await run(sh(), '(,1).Count')).trim()).toBe('1');
  });

  it('`(,@(1,2,3)).Count` is 1 — wraps the array, no flatten', async () => {
    expect((await run(sh(), '(,@(1,2,3)).Count')).trim()).toBe('1');
  });

  it('`$a = ,5; $a.Count` is 1 (was wrongly 2)', async () => {
    const s = sh();
    await run(s, '$a = ,5');
    expect((await run(s, '$a.Count')).trim()).toBe('1');
  });

  it('`@(,(1,2,3)).Count` is 1', async () => {
    expect((await run(sh(), '@(,(1,2,3)).Count')).trim()).toBe('1');
  });

  it('unary comma at scriptblock-body start parses (no command-not-found)', async () => {
    const out = await run(sh(), '1..3 | ForEach-Object { ,@($_, $_*2) }');
    expect(out).not.toMatch(/not recognized/i);
    expect(out).not.toMatch(/,@\(/);
  });

  it('`,$x` wraps a variable that holds an array', async () => {
    const s = sh();
    await run(s, '$x = 1,2,3,4');
    expect((await run(s, '(,$x).Count')).trim()).toBe('1');
    expect((await run(s, '$x.Count')).trim()).toBe('4');
  });

  it('does not break the binary comma operator', async () => {
    expect((await run(sh(), '(1,2,3).Count')).trim()).toBe('3');
    expect((await run(sh(), '@(1,2,3,4,5).Count')).trim()).toBe('5');
  });
});

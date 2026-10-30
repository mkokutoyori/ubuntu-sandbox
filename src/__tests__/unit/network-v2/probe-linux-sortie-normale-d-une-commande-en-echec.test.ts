/*
 * The shell reads the stdout of a command that exits non-zero without declaring a
 * stderr as a diagnostic when only one of the two streams is redirected. cmp,
 * grep and systemctl is-active/is-enabled/is-failed write their RESULT to stdout
 * and exit 1/3: `systemctl is-active x >/dev/null` printed "inactive" on the
 * terminal and `cmp a b 2>/dev/null` hid the verdict. They now declare an empty
 * stderr (printsResultOnFailure in LinuxCommandExecutor), diff does it in its own
 * case. A real error (ls of a missing file) keeps going to stderr, the witnesses.
 *
 * Measured before the change: 10 cases, 6 fall; the 4 witnesses (ls and cat
 * errors on stderr, the status itself) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(line: string): Promise<string> {
  const machine = new LinuxPC('linux-pc', 'PC1', 0, 0) as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('cd /tmp; printf "a\\n" > a; printf "b\\n" > b');
  return machine.executeCommand(line);
}

describe('witnesses: real diagnostics stay on stderr', () => {
  it('ls of a missing file is hidden by 2>/dev/null', async () => { expect(await run('ls /nope 2>/dev/null; echo $?')).toBe('2'); });
  it('ls of a missing file survives >/dev/null', async () => { expect(await run('ls /nope >/dev/null')).toContain("cannot access '/nope'"); });
  it('cat of a missing file is hidden by 2>/dev/null', async () => { expect(await run('cat /nope 2>/dev/null; echo $?')).toBe('1'); });
  it('the status of cmp is kept', async () => { expect(await run('cmp a b >/dev/null 2>&1; echo $?')).toBe('1'); });
});

describe('a result written on stdout follows stdout', () => {
  it('cmp a b >/dev/null prints nothing', async () => { expect(await run('cmp a b >/dev/null; echo $?')).toBe('1'); });
  it('cmp a b 2>/dev/null still prints the verdict', async () => { expect(await run('cmp a b 2>/dev/null')).toBe('a b differ: byte 1, line 1'); });
  it('systemctl is-active >/dev/null prints nothing', async () => { expect(await run('systemctl is-active nosuch >/dev/null; echo $?')).toBe('3'); });
  it('systemctl is-active 2>/dev/null still prints the state', async () => { expect(await run('systemctl is-active nosuch 2>/dev/null')).toBe('inactive'); });
  it('systemctl is-enabled >/dev/null prints nothing', async () => { expect(await run('systemctl is-enabled nosuch >/dev/null; echo $?')).toBe('1'); });
  it('grep -c with no match follows stdout', async () => { expect(await run('grep -c zzz a >/dev/null; echo $?')).toBe('1'); });
});

/*
 * `<(cmd)` ran its command through the synchronous driver, which refuses a
 * command that answers asynchronously: `while read l; do ...; done < <(awk ...)`
 * printed "bash: awk: cannot run an asynchronous command in a synchronous shell"
 * as the data of the loop (scenario10-linux-audit's score, computed from such
 * loops, was wrong). The words and redirections of a command are now
 * materialised by the same generator that runs the rest of the script, so the
 * inner command may be asynchronous. A pipeline into `while` still runs the
 * loop in a subshell, as bash does: the witnesses pin it.
 *
 * The cases run as a script file: typed at the prompt the same line is driven synchronously
 * and worked before.
 *
 * Measured before the change: 6 cases, 4 fall; the 2 witnesses (builtin inside
 * <( ), loop in a pipeline keeps the variable in a subshell) pass either way.
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';

type Sh = { executeCommand(line: string): Promise<string> };

async function run(line: string): Promise<string> {
  const machine = new LinuxServer('linux-server', 'S1') as unknown as Sh & { powerOn(): void };
  machine.powerOn();
  await machine.executeCommand('printf "b\\na\\n" > /tmp/p1; printf "a\\nc\\n" > /tmp/p2');
  await machine.executeCommand(`cat > /tmp/probe.sh << 'PROBE'\n${line}\nPROBE`);
  return machine.executeCommand('bash /tmp/probe.sh');
}

describe('witnesses', () => {
  it('a builtin inside <( )', async () => { expect(await run('cat <(echo hi)')).toBe('hi'); });
  it('a loop at the end of a pipeline works on a copy of the variables', async () => {
    expect(await run('N=0; printf "x\\ny\\n" | while read l; do N=$((N+1)); done; echo $N')).toBe('0');
  });
});

describe('an external command inside a process substitution', () => {
  it('awk as an argument', async () => { expect(await run("cat <(awk 'BEGIN{print 7}')")).toBe('7'); });
  it('awk as the input of a loop that keeps its variables', async () => {
    expect(await run("N=0; while read l; do N=$((N+1)); done < <(awk 'BEGIN{print 1; print 2; print 3}'); echo $N")).toBe('3');
  });
  it('two process substitutions side by side', async () => {
    expect(await run('diff <(sort /tmp/p1) <(sort /tmp/p2)')).toBe('2c2\n< b\n---\n> c');
  });
  it('a function called in the loop updates the caller', async () => {
    expect(await run("S=100; f(){ S=$((S-20)); }; while read l; do f; done < <(awk 'BEGIN{print 1; print 2}'); echo $S")).toBe('60');
  });
});

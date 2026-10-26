/**
 * `( ... ) &` and `{ ...; } &` are jobs, as in bash, measured on bash 5.2 in a fresh pid namespace:
 *
 *   (cd /tmp/d; exec sleep 100) & P=$!   $! is the subshell, which becomes `sleep` after exec, with cwd /tmp/d, and the shell stays in its directory
 *   jobs                                 `[1]+  Running                 ( cd /tmp/d; exec sleep 100 ) &` (marker, two spaces, state padded to 24)
 *   ( sleep 300 & echo $! > f; while true; do sleep 1; done ) &    the inner `sleep 300` is a child of the subshell, which stays alive
 *   typed line                           an interactive shell prints `[N] pid` for every job it starts, a script never does
 *
 * Measured with the sources before this change: 6 of the 10 cases fall (the group ran in the foreground: the job table stayed empty, the notice was
 * missing, `jobs` used 1 space after the marker and a 22-column state where bash uses 2 and 24, `(cd d; exec sleep 100)` left the shell in d, an endless loop spun to its iteration cap, the redirection of the group was ignored). The four
 * that pass either way are named: the clock and the child's parent (NON-REGRESSION: the old whole-line backgrounding already satisfied them), the
 * foreground subshell and the script (WITNESSES that the lab is sound).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function typed(line: string): Promise<string> {
  return pc.executeCommand(line);
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await typed('mkdir -p /tmp/d');
});

describe('background groups', () => {
  it('a subshell followed by & is a job and does not run in the foreground', async () => {
    const started = Date.now();
    expect(await typed('(cd /tmp/d; exec sleep 100) & echo $!')).toMatch(/^\[1\] (\d+)\n\1$/);
    expect(await typed('jobs')).toBe('[1]+  Running                 ( cd /tmp/d; exec sleep 100 ) &');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('jobs and jobs -l use the columns of bash: marker, two spaces, a 24-column state, then the command', async () => {
    await typed('(cd /tmp/d; exec sleep 100) &');
    await typed('sleep 200 &');
    expect(await typed('jobs')).toBe('[1]-  Running                 ( cd /tmp/d; exec sleep 100 ) &\n[2]+  Running                 sleep 200 &');
    expect(await typed('jobs -l')).toMatch(/^\[1\]- {1,4}\d+ Running {17}\( cd \/tmp\/d; exec sleep 100 \) &\n\[2\]\+ {1,4}\d+ Running {17}sleep 200 &$/);
  });

  it('exec replaces the subshell: comm, command and cwd are those of the new image', async () => {
    await typed('(cd /tmp/d; exec sleep 100) & P=$!');
    expect(await typed('ps -o pid,comm,args -p $P | tail -1')).toMatch(/sleep\s+sleep 100$/);
    expect(await typed('readlink /proc/$P/cwd')).toBe('/tmp/d');
  });

  it('the shell stays in its directory', async () => {
    await typed('(cd /tmp/d; exec sleep 100) & P=$!');
    expect(await typed('pwd')).toBe('/home/user');
  });

  it('a group runs its body once the clock moves, not before: sleep inside the group does not advance the shell clock', async () => {
    const before = await typed('date +%s');
    await typed('{ sleep 500; echo done; } &');
    const after = await typed('date +%s');
    expect(Number(after) - Number(before)).toBeLessThan(60);
  });

  it('a child started inside the group belongs to the group', async () => {
    const notice = await typed('( sleep 300 & echo $! > /tmp/child.pid; while true; do sleep 1; done ) &');
    const group = /^\[\d+\] (\d+)/.exec(notice)?.[1];
    const child = (await typed('cat /tmp/child.pid')).trim();
    expect(group).toBeDefined();
    expect((await typed(`ps -o ppid= -p ${child}`)).trim()).toBe(group);
  });

  it('a group parked in an endless loop stays alive until it is killed', async () => {
    await typed('( while true; do sleep 1; done ) & G=$!');
    expect(await typed('kill -0 $G && echo alive')).toBe('alive');
    await typed('kill $G');
    expect(await typed('kill -0 $G 2>&1; echo rc=$?')).toContain('rc=1');
  });

  it('the output of a group with a redirection reaches the file', async () => {
    await typed('( echo hello ) > /tmp/g.txt &');
    expect((await typed('cat /tmp/g.txt')).replace(/^\[\d+\][+-]? .*\n?/gm, '')).toBe('hello');
  });

  it('WITNESS: a foreground subshell never leaked its directory', async () => {
    expect(await typed('( cd /tmp/d; pwd ); pwd')).toBe('/tmp/d\n/home/user');
  });

  it('WITNESS: a script started jobs without announcing them', async () => {
    await typed('printf "sleep 100 &\\n(sleep 100) &\\n" > /tmp/s.sh');
    expect(await typed('bash /tmp/s.sh')).toBe('');
  });
});

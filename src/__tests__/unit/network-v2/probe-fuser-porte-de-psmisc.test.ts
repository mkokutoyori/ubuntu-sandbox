/**
 * fuser is the C program of psmisc 23.7 (src/fuser.c read in full: argument loop, parse_inet, scan_procs, check_dir, print_matches, kill_matched_proc),
 * and what it does is measured on the real binary in a fresh network and pid namespace (the oracle corpus is replayed by netcmds-oracle.test.ts;
 * these cases pin the pieces that corpus cannot name):
 *
 *   streams            names, letters and the verbose table go to stderr; the pids go to stdout (`kill $(fuser -s f)` works), each as " %5d"
 *   name field         20 columns: a name shorter than 20 is padded, 20 is exact, 21 or more pushes the table to the next line in verbose mode
 *   kernel threads     /proc/2/cwd and /proc/2/root are "/": `fuser -vm /` lists them `.rc..` (the former stub claimed fuser never counts them)
 *   `--`               stops the argument loop: `fuser -- /tmp` has no process specification
 *   signals            `-9` accumulates digits (but 4 and 6 are -4 / -6), `-TERM` is a name, `-kTERM` is not an option cluster: "kTERM: unknown signal"
 *   -w with -k         kills only the processes that hold the file open for writing (lrwx on the descriptor link)
 *
 * Measured with the sources before this change: 10 of the 11 cases fall (the stub had no namespace, no streams, no access letters beyond c and f, no
 * kernel threads, no `--`, no `-a`, 23.4 as its version). The one that passes either way is the unused-file witness (nothing printed, rc 1), which
 * proves the lab is sound.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

let pc: LinuxPC;

async function root(line: string): Promise<string> {
  const machine = pc as unknown as { executor: { runAsUser<T>(user: string, run: () => Promise<T>): Promise<T> } };
  return (await machine.executor.runAsUser('root', () => pc.executeCommand(line))).replace(/^\[\d+\] \d+\n?/gm, '');
}

async function holder(command: string): Promise<string> {
  await root(`${command} & H=$!`);
  return (await root('echo $H')).trim();
}

beforeEach(async () => {
  EquipmentRegistry.resetInstance();
  pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  pc.powerOn();
  await root('ip link set lo up');
  await root('mkdir -p /tmp/lab');
});

const pad = (pid: string, width: number): string => pid.padStart(width);

describe('fuser as psmisc 23.7 prints it', () => {
  it('the pids alone go to stdout and the rest to stderr', async () => {
    await root(': > /tmp/lab/f');
    const pid = await holder('sleep 200 < /tmp/lab/f');
    expect(await root('echo "[$(fuser /tmp/lab/f 2>/dev/null)]"')).toBe(`[${pad(pid, 6)}]`);
    expect(await root('fuser -v /tmp/lab/f 2>&1')).toBe(`${' '.repeat(21)}USER        PID ACCESS COMMAND\n${'/tmp/lab/f:'.padEnd(20)} root      ${pad(pid, 5)} f.... sleep`);
    expect(await root('fuser -v /tmp/lab/f 2>&1 >/dev/null')).toBe(`${' '.repeat(21)}USER        PID ACCESS COMMAND\n${'/tmp/lab/f:'.padEnd(20)} root      f.... sleep`);
  });

  it('the name field is 20 columns wide and a longer name pushes the verbose rows to the next line', async () => {
    await root(': > /abcdefghijklmnopq; : > /abcdefghijklmnopqr; : > /abcdefghijklmnopqrs');
    const a = await holder('sleep 201 < /abcdefghijklmnopq');
    const b = await holder('sleep 202 < /abcdefghijklmnopqr');
    const c = await holder('sleep 203 < /abcdefghijklmnopqrs');
    expect(await root('fuser /abcdefghijklmnopq 2>&1')).toBe(`/abcdefghijklmnopq:${pad(a, 6 + 1)}`);
    expect(await root('fuser /abcdefghijklmnopqr 2>&1')).toBe(`/abcdefghijklmnopqr:${pad(b, 6)}`);
    expect(await root('fuser /abcdefghijklmnopqrs 2>&1')).toBe(`/abcdefghijklmnopqrs:${pad(c, 6)}`);
    expect(await root('fuser -v /abcdefghijklmnopqr 2>&1 | tail -1')).toBe(`/abcdefghijklmnopqr: root ${pad(b, 10)} f.... sleep`);
    expect(await root('fuser -v /abcdefghijklmnopqrs 2>&1 | tail -2')).toBe(`/abcdefghijklmnopqrs:\n${' '.repeat(21)}root ${pad(c, 10)} f.... sleep`);
  });

  it('the kernel threads hold / by their cwd and root', async () => {
    const listing = await root('fuser -vm / 2>&1');
    expect(listing).toMatch(/^ {21}USER {8}PID ACCESS COMMAND\n\/: {19}root {5}kernel mount \/\n/);
    expect(listing).toMatch(/ root +2 \.rc\.\. kthreadd$/m);
  });

  it('-- ends the options and leaves no process specification', async () => {
    expect(await root('fuser -- /tmp 2>&1 | head -1')).toBe('No process specification given');
  });

  it('digits are a signal number, 4 and 6 are the IP versions, a signal name is read whole', async () => {
    await root(': > /tmp/lab/f');
    const pid = await holder('sleep 204 < /tmp/lab/f');
    expect(await root('fuser -6 -4 /tmp/lab/f 2>&1 | head -1')).toBe('You cannot search for only IPv4 and only IPv6 sockets at the same time');
    expect(await root('fuser -k -FOO /tmp/lab/f 2>&1; echo rc=$?')).toBe('FOO: unknown signal; fuser -l lists signals.\nrc=1');
    expect(await root('fuser -kTERM /tmp/lab/f 2>&1; echo rc=$?')).toBe('kTERM: unknown signal; fuser -l lists signals.\nrc=1');
    expect(await root(`kill -0 ${pid} && echo alive`)).toBe('alive');
    await root('fuser -k -9 /tmp/lab/f > /dev/null 2>&1');
    expect(await root(`kill -0 ${pid} 2>&1; echo rc=$?`)).toContain('rc=1');
  });

  it('-w with -k kills the writers and spares the readers', async () => {
    await root(': > /tmp/lab/g');
    const reader = await holder('sleep 205 < /tmp/lab/g');
    const writer = await holder('sleep 206 >> /tmp/lab/g');
    expect(await root('fuser -v /tmp/lab/g 2>&1')).toMatch(new RegExp(` ${reader} f\\.{4} sleep\\n +root +${writer} F\\.{4} sleep$`));
    await root('fuser -kw /tmp/lab/g > /dev/null 2>&1');
    expect(await root(`kill -0 ${reader} && echo reader-alive`)).toBe('reader-alive');
    expect(await root(`kill -0 ${writer} 2>&1; echo rc=$?`)).toContain('rc=1');
  });

  it('a socket is held with F and found by port, protocol and remote endpoint', async () => {
    const server = await holder('nc -l 127.0.0.1 9000');
    await root('sleep 0.3');
    expect(await root('fuser -v 9000/tcp 2>&1')).toBe(`${' '.repeat(21)}USER${' '.repeat(8)}PID ACCESS COMMAND\n9000/tcp:${' '.repeat(12)}root ${pad(server, 10)} F.... nc`);
    expect(await root('fuser 9000/udp 2>&1; echo rc=$?')).toBe('rc=1');
    const client = await holder('nc -p 40001 127.0.0.1 9000');
    await root('sleep 0.3');
    expect(await root('fuser ,,40001/tcp 2>&1')).toBe(`,,40001/tcp:${pad(server, 6 + 8)}`);
    expect(await root('fuser 40001,127.0.0.1,9000/tcp 2>&1')).toBe(`40001,127.0.0.1,9000/tcp:${pad(client, 6)}`);
  });

  it('-V prints the version of the recorded binary on stderr', async () => {
    expect(await root('fuser -V 2>&1 | head -1')).toBe('fuser (PSmisc) 23.7');
    expect(await root('fuser -V 2>/dev/null; echo rc=$?')).toBe('rc=0');
  });

  it('-l lists the signals on stdout, wrapped at 80 columns', async () => {
    expect(await root('fuser -l | head -2')).toBe('HUP INT QUIT ILL TRAP ABRT BUS FPE KILL USR1 SEGV USR2 PIPE ALRM TERM STKFLT\nCHLD CONT STOP TSTP TTIN TTOU URG XCPU XFSZ VTALRM PROF WINCH POLL PWR SYS');
  });

  it('WITNESS: an unused file prints nothing and exits 1', async () => {
    await root(': > /tmp/lab/unused');
    expect(await root('fuser /tmp/lab/unused 2>&1; echo rc=$?')).toBe('rc=1');
  });

  it('-a prints the bare name of an unused file', async () => {
    await root(': > /tmp/lab/unused');
    expect(await root('fuser -a /tmp/lab/unused 2>&1; echo rc=$?')).toBe('/tmp/lab/unused:\nrc=1');
  });
});

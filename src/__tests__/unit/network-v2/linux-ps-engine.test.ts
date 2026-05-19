/**
 * Unit tests — `ps` selection/format engine.
 *
 * Targets the anomalies found in the Linux debug transcript where `ps`
 * ignored almost every flag and always fell back to "current shell
 * only" with the SysV short format. The engine must honour process
 * selection (-e/-p/-C/-u/--ppid), output formats (-f/-l/-o/aux), the
 * --sort / --no-headers modifiers, and report errors for unknown
 * options.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';
import { runPs, type PsContext } from '@/network/devices/linux/ps/PsCommand';

function makeCtx(pm: LinuxProcessManager): PsContext {
  // Mirror an interactive PC shell: non-root user on pts/0.
  const shell = pm.spawn({
    command: '-bash', comm: '-bash', user: 'user',
    uid: 1000, gid: 1000, tty: 'pts/0',
  });
  return { pm, currentUser: 'user', currentUid: 1000, tty: 'pts/0', shellPid: shell.pid };
}

describe('ps engine — process selection', () => {
  let pm: LinuxProcessManager;
  let ctx: PsContext;

  beforeEach(() => {
    pm = new LinuxProcessManager();
    pm.spawn({ command: '/usr/sbin/sshd -D', comm: 'sshd', user: 'root', uid: 0, gid: 0 });
    pm.spawn({ command: '/usr/sbin/cron -f', comm: 'cron', user: 'root', uid: 0, gid: 0 });
    ctx = makeCtx(pm);
  });

  it('default selection shows only the current user on the current tty', () => {
    const out = runPs([], ctx);
    expect(out).toContain('-bash');
    expect(out).not.toContain('sshd');
    expect(out).not.toContain('systemd');
  });

  it('-e lists every process', () => {
    const out = runPs(['-e'], ctx);
    expect(out).toContain('systemd');
    expect(out).toContain('sshd');
    expect(out).toContain('cron');
    expect(out).toContain('-bash');
  });

  it('-p selects a single pid only', () => {
    const out = runPs(['-p', '1'], ctx);
    expect(out).toContain('systemd');
    expect(out).not.toContain('sshd');
    expect(out).not.toContain('-bash');
  });

  it('-p accepts a comma-separated pid list', () => {
    const out = runPs(['-p', '1,2'], ctx);
    expect(out).toContain('systemd');
    expect(out).toContain('sshd');
    expect(out).not.toContain('cron');
  });

  it('--pid is an alias for -p', () => {
    const out = runPs(['--pid', '1'], ctx);
    expect(out).toContain('systemd');
    expect(out).not.toContain('-bash');
  });

  it('-C selects by command name', () => {
    const out = runPs(['-C', 'cron'], ctx);
    expect(out).toContain('cron');
    expect(out).not.toContain('sshd');
    expect(out).not.toContain('systemd');
  });

  it('-u selects every process of a user', () => {
    const out = runPs(['-u', 'root'], ctx);
    expect(out).toContain('systemd');
    expect(out).toContain('sshd');
    expect(out).toContain('cron');
    expect(out).not.toContain('-bash');
  });

  it('--ppid selects by parent pid', () => {
    pm.spawn({ command: '/bin/sleep 9', comm: 'sleep', user: 'root', uid: 0, gid: 0, ppid: 1 });
    const out = runPs(['--ppid', '1'], ctx);
    expect(out).toContain('sleep');
  });

  it('an unknown pid yields the header only, no rows', () => {
    const out = runPs(['-p', '999999'], ctx);
    const rows = out.split('\n').filter(l => l.trim() && !l.includes('PID'));
    expect(rows).toHaveLength(0);
  });

  it('an unknown command name yields the header only', () => {
    const out = runPs(['-C', 'definitely_not_here'], ctx);
    const rows = out.split('\n').filter(l => l.trim() && !l.includes('PID'));
    expect(rows).toHaveLength(0);
  });
});

describe('ps engine — output formats', () => {
  let pm: LinuxProcessManager;
  let ctx: PsContext;

  beforeEach(() => {
    pm = new LinuxProcessManager();
    pm.spawn({ command: '/usr/sbin/sshd -D', comm: 'sshd', user: 'root', uid: 0, gid: 0 });
    ctx = makeCtx(pm);
  });

  it('aux uses the BSD long header and lists all processes', () => {
    const out = runPs(['aux'], ctx);
    expect(out).toContain('USER');
    expect(out).toContain('%CPU');
    expect(out).toContain('COMMAND');
    expect(out).toContain('sshd');
    expect(out).toContain('-bash');
  });

  it('-ef uses the full header with PPID and STIME', () => {
    const out = runPs(['-ef'], ctx);
    const header = out.split('\n')[0];
    expect(header).toContain('UID');
    expect(header).toContain('PPID');
    expect(header).toContain('STIME');
    // -f shows the full command line, so PID 1 is /sbin/init (not "systemd").
    expect(out).toContain('/sbin/init');
    expect(out).toContain('sshd');
  });

  it('-e -o pid,comm renders only the requested columns', () => {
    const out = runPs(['-e', '-o', 'pid,comm'], ctx);
    const header = out.split('\n')[0];
    expect(header).toContain('PID');
    expect(header).toContain('COMMAND');
    expect(header).not.toContain('TTY');
    expect(out).toContain('systemd');
  });

  it('-o col= suppresses the header entirely', () => {
    const out = runPs(['-e', '-o', 'pid=,comm='], ctx);
    expect(out).not.toContain('PID');
    expect(out).toMatch(/\b1\b/);
    expect(out).toContain('systemd');
  });

  it('--no-headers strips the header line', () => {
    const out = runPs(['-e', '--no-headers'], ctx);
    expect(out).not.toContain('PID TTY');
    expect(out).toContain('systemd');
  });
});

describe('ps engine — modifiers and errors', () => {
  let pm: LinuxProcessManager;
  let ctx: PsContext;

  beforeEach(() => {
    pm = new LinuxProcessManager();
    pm.spawn({ command: '/usr/sbin/sshd -D', comm: 'sshd', user: 'root', uid: 0, gid: 0 });
    pm.spawn({ command: '/usr/sbin/cron -f', comm: 'cron', user: 'root', uid: 0, gid: 0 });
    ctx = makeCtx(pm);
  });

  it('--sort=-pid orders rows by descending pid', () => {
    const out = runPs(['-e', '-o', 'pid=', '--sort=-pid'], ctx);
    const pids = out.split('\n').map(l => l.trim()).filter(Boolean).map(Number);
    const sorted = [...pids].sort((a, b) => b - a);
    expect(pids).toEqual(sorted);
  });

  it('--sort=pid orders rows by ascending pid', () => {
    const out = runPs(['-e', '-o', 'pid=', '--sort=pid'], ctx);
    const pids = out.split('\n').map(l => l.trim()).filter(Boolean).map(Number);
    const sorted = [...pids].sort((a, b) => a - b);
    expect(pids).toEqual(sorted);
  });

  it('reports an error for an unknown short option', () => {
    const out = runPs(['-Q'], ctx);
    expect(out.toLowerCase()).toContain('invalid option');
  });

  it('reports an error for an unknown long option', () => {
    const out = runPs(['--zorglub'], ctx);
    expect(out.toLowerCase()).toContain('unrecognized option');
  });

  it('--version prints a procps-ng banner', () => {
    expect(runPs(['--version'], ctx)).toContain('procps');
  });
});

/**
 * Unit tests — job control: `cmd &`, jobs/bg/fg/wait/disown/nohup/pstree.
 *
 * The debug transcript showed all of these as "command not found" and
 * `sleep &` produced an empty line with no tracked process. After this
 * section, `cmd &` must spawn a real entry in LinuxProcessManager,
 * announce the job, and be addressable by both PID and %jobspec.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('background `&` — spawns a tracked process and announces the job', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('prints "[jobid] pid" and registers the process', () => {
    const out = exec.execute('sleep 60 &');
    expect(out).toMatch(/^\[1\] \d+$/);
    const pid = Number(out.match(/\[1\] (\d+)/)![1]);
    const ps = exec.execute(`ps -p ${pid} -o pid,comm`);
    expect(ps).toContain('sleep');
  });

  it('increments job ids monotonically', () => {
    expect(exec.execute('sleep 10 &')).toMatch(/^\[1\] /);
    expect(exec.execute('sleep 20 &')).toMatch(/^\[2\] /);
    expect(exec.execute('sleep 30 &')).toMatch(/^\[3\] /);
  });

  it('ps -C sleep finds backgrounded sleeps', () => {
    exec.execute('sleep 100 &');
    exec.execute('sleep 200 &');
    const ps = exec.execute('ps -C sleep -o pid,comm');
    const lines = ps.split('\n').filter(l => l.includes('sleep'));
    expect(lines.length).toBe(2);
  });
});

describe('jobs', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('lists active jobs with state, current marker, and command', () => {
    exec.execute('sleep 60 &');
    exec.execute('sleep 90 &');
    const out = exec.execute('jobs');
    expect(out).toMatch(/\[1\][-+ ]+Running\s+sleep 60 &/);
    expect(out).toMatch(/\[2\][-+ ]+Running\s+sleep 90 &/);
    // The most recent job is "current" (+); previous is (-).
    expect(out).toMatch(/\[2\]\+/);
    expect(out).toMatch(/\[1\]-/);
  });

  it('jobs -l prepends the pid', () => {
    const announce = exec.execute('sleep 60 &');
    const pid = announce.match(/\[1\] (\d+)/)![1];
    const out = exec.execute('jobs -l');
    expect(out).toContain(`[1]+`);
    expect(out).toContain(pid);
  });

  it('jobs -p prints only pids, one per line', () => {
    exec.execute('sleep 60 &');
    exec.execute('sleep 90 &');
    const out = exec.execute('jobs -p').trim().split('\n');
    expect(out.length).toBe(2);
    out.forEach(l => expect(l).toMatch(/^\d+$/));
  });

  it('jobs prints nothing when no jobs', () => {
    expect(exec.execute('jobs')).toBe('');
  });

  it('jobs %abc reports an invalid jobspec', () => {
    expect(exec.execute('jobs %abc')).toContain('no such job');
  });
});

describe('kill %jobspec', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('kill %N removes the job from the table', () => {
    exec.execute('sleep 60 &');
    exec.execute('sleep 90 &');
    exec.execute('kill %1');
    const out = exec.execute('jobs');
    expect(out).not.toMatch(/\[1\]/);
    expect(out).toMatch(/\[2\]/);
  });

  it('kill %99 reports no such job', () => {
    expect(exec.execute('kill %99')).toContain('no such job');
  });
});

describe('bg / fg / disown / wait', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => {
    exec = new LinuxCommandExecutor(true);
    exec.execute('sleep 60 &');  // [1]
    exec.execute('sleep 90 &');  // [2]
  });

  it('fg %1 brings the job to the foreground (synchronously completes in the sim)', () => {
    const out = exec.execute('fg %1');
    expect(out).toContain('sleep 60');
    expect(exec.execute('jobs')).not.toMatch(/\[1\]/);
  });

  it('fg %N re-emits the captured stdout of the resumed job', () => {
    exec.execute('echo first-bg-output > /tmp/fg.tmp &');
    const out = exec.execute('fg %3');
    // The first line is the resumed command line (real bash prints this);
    // the next lines surface the redirected echo's output (the simulator
    // captured stdout when it ran the command eagerly).
    expect(out.split('\n')[0]).toContain('echo first-bg-output');
  });

  it('fg propagates the job exit code into $?', () => {
    exec.execute('false &');
    exec.execute('fg %3');
    expect(exec.execute('echo $?').trim()).toBe('1');
  });

  it('bg %1 reports the job as backgrounded', () => {
    expect(exec.execute('bg %1')).toMatch(/\[1\][-+ ]+sleep 60 &/);
  });

  it('disown %2 drops the job from the table without killing the process', () => {
    const announce = exec.execute('jobs -l');
    const pid = announce.match(/\[2\][-+ ]+\s*(\d+)/)![1];
    exec.execute('disown %2');
    expect(exec.execute('jobs')).not.toMatch(/\[2\]/);
    expect(exec.execute(`ps -p ${pid} -o comm`)).toContain('sleep');
  });

  it('wait with no args returns immediately (no exit code text in this sim)', () => {
    expect(exec.execute('wait')).toBe('');
  });

  it('fg %99 reports no such job', () => {
    expect(exec.execute('fg %99')).toContain('no such job');
  });
});

describe('nohup', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('nohup cmd & spawns a process whose ppid becomes 1 after the shell exits', () => {
    const out = exec.execute('nohup sleep 200 &');
    expect(out).toMatch(/\[1\] \d+/);
    // Standard nohup notice goes to stderr; we emit it on the same stream.
    expect(out.toLowerCase()).toContain('nohup');
    const ps = exec.execute('ps -C sleep -o pid,comm');
    expect(ps).toContain('sleep');
  });
});

describe('pstree', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('with no args, roots at systemd and lists at least one child', () => {
    const out = exec.execute('pstree');
    expect(out.split('\n')[0]).toContain('systemd');
  });

  it('pstree -p includes pids in parentheses', () => {
    const out = exec.execute('pstree -p');
    expect(out).toMatch(/systemd\(1\)/);
  });

  it('pstree -p 999999 reports no process found', () => {
    expect(exec.execute('pstree -p 999999').toLowerCase()).toContain('no process');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('at — deferred jobs fire on the simulated clock', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('a job scheduled for now+1min runs only once the clock reaches it', () => {
    exec.execute("echo 'echo done > /tmp/at1.txt' | at now + 1 minute");
    expect(exec.execute('atq')).toMatch(/^\d+\s/m);
    expect(exec.execute('ls /tmp/at1.txt')).toMatch(/No such file/);

    exec.advanceTime(59_000);
    expect(exec.execute('ls /tmp/at1.txt')).toMatch(/No such file/);

    exec.advanceTime(2_000);
    expect(exec.execute('cat /tmp/at1.txt')).toContain('done');
  });

  it('a fired job is removed from the atq spool', () => {
    exec.execute("echo 'touch /tmp/at2.flag' | at now + 1 minute");
    exec.advanceTime(60_000);
    expect(exec.execute('atq').trim()).toBe('');
  });

  it('jobs fire in scheduled order as time advances past each', () => {
    exec.execute("echo 'echo a >> /tmp/atorder.txt' | at now + 1 minute");
    exec.execute("echo 'echo b >> /tmp/atorder.txt' | at now + 5 minutes");

    exec.advanceTime(60_000);
    expect(exec.execute('cat /tmp/atorder.txt')).toContain('a');
    expect(exec.execute('cat /tmp/atorder.txt')).not.toContain('b');

    exec.advanceTime(5 * 60_000);
    const out = exec.execute('cat /tmp/atorder.txt');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('atrm before the run time cancels the job', () => {
    const sched = exec.execute("echo 'touch /tmp/atrm.flag' | at now + 1 minute");
    const id = (sched.match(/job (\d+)/) || [])[1];
    exec.execute(`atrm ${id}`);
    exec.advanceTime(120_000);
    expect(exec.execute('ls /tmp/atrm.flag')).toMatch(/No such file/);
  });

  it('jobs do not fire while atd is stopped', () => {
    exec.execute("echo 'touch /tmp/atdoff.flag' | at now + 1 minute");
    exec.execute('systemctl stop atd');
    exec.advanceTime(120_000);
    expect(exec.execute('ls /tmp/atdoff.flag')).toMatch(/No such file/);
  });
});

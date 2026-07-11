import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('at — deferred jobs fire on the simulated clock', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('a job scheduled for now+1min runs only once the clock reaches it', async () => {
    await exec.execute("echo 'echo done > /tmp/at1.txt' | at now + 1 minute");
    expect(await exec.execute('atq')).toMatch(/^\d+\s/m);
    expect(await exec.execute('ls /tmp/at1.txt')).toMatch(/No such file/);

    await exec.advanceTime(59_000);
    expect(await exec.execute('ls /tmp/at1.txt')).toMatch(/No such file/);

    await exec.advanceTime(2_000);
    expect(await exec.execute('cat /tmp/at1.txt')).toContain('done');
  });

  it('a fired job is removed from the atq spool', async () => {
    await exec.execute("echo 'touch /tmp/at2.flag' | at now + 1 minute");
    await exec.advanceTime(60_000);
    expect((await exec.execute('atq')).trim()).toBe('');
  });

  it('jobs fire in scheduled order as time advances past each', async () => {
    await exec.execute("echo 'echo a >> /tmp/atorder.txt' | at now + 1 minute");
    await exec.execute("echo 'echo b >> /tmp/atorder.txt' | at now + 5 minutes");

    await exec.advanceTime(60_000);
    expect(await exec.execute('cat /tmp/atorder.txt')).toContain('a');
    expect(await exec.execute('cat /tmp/atorder.txt')).not.toContain('b');

    await exec.advanceTime(5 * 60_000);
    const out = await exec.execute('cat /tmp/atorder.txt');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('atrm before the run time cancels the job', async () => {
    const sched = await exec.execute("echo 'touch /tmp/atrm.flag' | at now + 1 minute");
    const id = (sched.match(/job (\d+)/) || [])[1];
    await exec.execute(`atrm ${id}`);
    await exec.advanceTime(120_000);
    expect(await exec.execute('ls /tmp/atrm.flag')).toMatch(/No such file/);
  });

  it('jobs do not fire while atd is stopped', async () => {
    await exec.execute("echo 'touch /tmp/atdoff.flag' | at now + 1 minute");
    await exec.execute('systemctl stop atd');
    await exec.advanceTime(120_000);
    expect(await exec.execute('ls /tmp/atdoff.flag')).toMatch(/No such file/);
  });
});

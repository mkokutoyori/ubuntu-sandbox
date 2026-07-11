import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('cron — system crontab jobs fire on the simulated clock', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('an every-minute job runs once a minute has elapsed', async () => {
    await exec.execute("echo '* * * * * root touch /tmp/cron-ran' > /etc/crontab");
    expect(await exec.execute('ls /tmp/cron-ran')).toMatch(/No such file/);
    await exec.advanceTime(60_000);
    expect(await exec.execute('ls /tmp/cron-ran')).not.toMatch(/No such file/);
  });

  it('an every-minute job fires three times over three minutes', async () => {
    await exec.execute("echo '* * * * * root echo tick >> /tmp/ticks.log' > /etc/crontab");
    await exec.advanceTime(3 * 60_000);
    const count = (await exec.execute('cat /tmp/ticks.log')).split('tick').length - 1;
    expect(count).toBe(3);
  });

  it('a */2 job fires on every other minute', async () => {
    await exec.execute("echo '*/2 * * * * root echo even >> /tmp/even.log' > /etc/crontab");
    await exec.advanceTime(4 * 60_000);
    const count = (await exec.execute('cat /tmp/even.log')).split('even').length - 1;
    expect(count).toBe(2);
  });

  it('no jobs fire while cron is stopped', async () => {
    await exec.execute("echo '* * * * * root touch /tmp/cron-off' > /etc/crontab");
    await exec.execute('systemctl stop cron');
    await exec.advanceTime(5 * 60_000);
    expect(await exec.execute('ls /tmp/cron-off')).toMatch(/No such file/);
  });
});

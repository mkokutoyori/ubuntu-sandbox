import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('cron — system crontab jobs fire on the simulated clock', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('an every-minute job runs once a minute has elapsed', () => {
    exec.execute("echo '* * * * * root touch /tmp/cron-ran' > /etc/crontab");
    expect(exec.execute('ls /tmp/cron-ran')).toMatch(/No such file/);
    exec.advanceTime(60_000);
    expect(exec.execute('ls /tmp/cron-ran')).not.toMatch(/No such file/);
  });

  it('an every-minute job fires three times over three minutes', () => {
    exec.execute("echo '* * * * * root echo tick >> /tmp/ticks.log' > /etc/crontab");
    exec.advanceTime(3 * 60_000);
    const count = exec.execute('cat /tmp/ticks.log').split('tick').length - 1;
    expect(count).toBe(3);
  });

  it('a */2 job fires on every other minute', () => {
    exec.execute("echo '*/2 * * * * root echo even >> /tmp/even.log' > /etc/crontab");
    exec.advanceTime(4 * 60_000);
    const count = exec.execute('cat /tmp/even.log').split('even').length - 1;
    expect(count).toBe(2);
  });

  it('no jobs fire while cron is stopped', () => {
    exec.execute("echo '* * * * * root touch /tmp/cron-off' > /etc/crontab");
    exec.execute('systemctl stop cron');
    exec.advanceTime(5 * 60_000);
    expect(exec.execute('ls /tmp/cron-off')).toMatch(/No such file/);
  });
});

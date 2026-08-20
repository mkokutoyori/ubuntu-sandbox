import { describe, it, expect } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';
import { LinuxProcessManager } from '@/network/devices/linux/LinuxProcessManager';

describe('honest CPU accounting', () => {
  it('running processes accrue CPU time on the clock; sleeping ones do not', () => {
    const pm = new LinuxProcessManager();
    const busy = pm.spawn({ command: 'busy', comm: 'busy', user: 'root', uid: 0, gid: 0 });
    const idle = pm.spawn({ command: 'idle', comm: 'idle', user: 'root', uid: 0, gid: 0 });
    pm.setState(busy.pid, 'R');
    pm.accrueCpu(5000);
    expect(pm.get(busy.pid)!.cpuTime).toBe(5000);
    expect(pm.get(idle.pid)!.cpuTime).toBe(0);
  });

  it('top reports real per-process CPU time, not a hardcoded constant', () => {
    const e = new LinuxCommandExecutor(true);
    expect(e.execute('top')).not.toContain('0:00.10');
  });

  it('top load average reflects the runnable count (idle box → 0.00)', () => {
    const e = new LinuxCommandExecutor(true);
    const header = e.execute('top').split('\n')[0];
    expect(header).toMatch(/load average: 0\.00, 0\.00, 0\.00/);
  });

  it('top %Cpu(s) summary reflects an idle box, not a hardcoded busy line', () => {
    const e = new LinuxCommandExecutor(true);
    const cpuLine = e.execute('top').split('\n').find((l) => l.startsWith('%Cpu'));
    expect(cpuLine).toMatch(/100\.0 id/);
    expect(cpuLine).not.toContain('98.2 id');
  });

  it('a long sleeping background job accrues no CPU as the clock advances', () => {
    const e = new LinuxCommandExecutor(true);
    e.execute('sleep 100 &');
    e.advanceTime(50_000);
    const row = e.execute('ps -e -o stat,time,comm').split('\n').find((l) => l.includes('sleep'));
    expect(row).toMatch(/00:00/);
  });
});

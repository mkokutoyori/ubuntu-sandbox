import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('Realistic background jobs over a simulated clock', () => {
  let exec: LinuxCommandExecutor;
  beforeEach(() => { exec = new LinuxCommandExecutor(true); });

  it('a backgrounded sleep stays Running until its duration elapses', () => {
    exec.execute('sleep 60 &');
    expect(exec.execute('jobs')).toMatch(/\[1\][-+ ]+Running\s+sleep 60 &/);

    exec.advanceTime(59_000);
    expect(exec.execute('jobs')).toMatch(/Running\s+sleep 60 &/);

    exec.advanceTime(2_000); // now past 60s
    expect(exec.execute('jobs')).not.toMatch(/Running\s+sleep 60/);
  });

  it('prints a [N]+ Done notification before the next prompt when a bg job finishes', () => {
    exec.execute('sleep 5 &');
    exec.advanceTime(5_000);
    const next = exec.execute('echo after');
    expect(next).toMatch(/\[1\]\+\s+Done\s+sleep 5/);
    expect(next).toContain('after');
  });

  it('the backgrounded process disappears from ps once it completes (reaped)', () => {
    exec.execute('sleep 30 &');
    expect(exec.execute('ps -e -o pid,comm')).toMatch(/\bsleep\b/);
    exec.advanceTime(30_000);
    exec.execute('true'); // flush completion/reaping on the next prompt
    expect(exec.execute('ps -e -o pid,comm')).not.toMatch(/\bsleep\b/);
  });

  it('wait blocks until all background jobs complete (advancing simulated time)', () => {
    exec.execute('sleep 10 &');
    exec.execute('sleep 25 &');
    const before = exec.simulatedNow();
    exec.execute('wait');
    expect(exec.simulatedNow()).toBeGreaterThanOrEqual(before + 25_000);
    expect(exec.execute('jobs').trim()).toBe('');
  });

  it('wait %n waits only for the named job', () => {
    exec.execute('sleep 10 &');
    exec.execute('sleep 90 &');
    exec.execute('wait %1');
    const jobs = exec.execute('jobs');
    expect(jobs).not.toMatch(/sleep 10/);
    expect(jobs).toMatch(/Running\s+sleep 90/);
  });

  it('two staggered sleeps complete in duration order as the clock advances', () => {
    exec.execute('sleep 10 &');
    exec.execute('sleep 40 &');
    exec.advanceTime(10_000);
    let jobs = exec.execute('jobs');
    expect(jobs).not.toMatch(/Running\s+sleep 10/);
    expect(jobs).toMatch(/Running\s+sleep 40/);
    exec.advanceTime(30_000);
    exec.execute('true'); // flush the [2]+ Done notice before the next prompt
    expect(exec.execute('jobs').trim()).toBe('');
  });

  it('an instant backgrounded command completes on the next prompt', () => {
    exec.execute('echo hi > /tmp/bg.txt &');
    const next = exec.execute('true');
    expect(next).toMatch(/\[1\]\+\s+Done/);
    expect(exec.execute('cat /tmp/bg.txt')).toContain('hi');
  });
});

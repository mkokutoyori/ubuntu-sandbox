/**
 * Unit tests — nice / renice / chrt / ionice / taskset.
 *
 * The debug transcript had all of these as "command not found", so the
 * whole priority set/show pattern was dead. They must now mutate the
 * live process table, be reflected by the read-back command, emit the
 * reactive priority-changed event (renice), and report proper errors.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '@/events/EventBus';
import { LinuxCommandExecutor } from '@/network/devices/linux/LinuxCommandExecutor';

describe('renice — set then show', () => {
  let exec: LinuxCommandExecutor;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(true);
  });

  it('renice changes a pid niceness and ps reflects it', () => {
    const pid = exec.execute('echo $$').trim();
    const out = exec.execute(`renice 5 -p ${pid}`);
    expect(out).toContain(`old priority 0, new priority 5`);
    const ps = exec.execute(`ps -o pid,ni,comm -p ${pid}`);
    expect(ps).toMatch(/\b5\b/);
  });

  it('renice publishes linux.process.priority-changed', () => {
    const bus = new EventBus();
    exec.attachEventBus(bus, 'prio-1');
    const seen: number[] = [];
    bus.subscribe('linux.process.priority-changed', e => seen.push(e.payload.newNice));
    const pid = exec.execute('echo $$').trim();
    exec.execute(`renice 8 -p ${pid}`);
    expect(seen).toContain(8);
  });

  it('renice rejects a non-numeric priority', () => {
    const pid = exec.execute('echo $$').trim();
    expect(exec.execute(`renice abc -p ${pid}`)).toContain('invalid priority');
  });

  it('renice on an unknown pid reports No such process', () => {
    expect(exec.execute('renice 5 -p 999999')).toContain('No such process');
  });

  it('renice with no argument prints usage', () => {
    expect(exec.execute('renice')).toContain('usage');
  });
});

describe('nice', () => {
  it('nice with no command prints the current niceness', () => {
    const exec = new LinuxCommandExecutor(true);
    expect(exec.execute('nice').trim()).toBe('0');
  });

  it('nice -n with an invalid adjustment errors', () => {
    const exec = new LinuxCommandExecutor(true);
    expect(exec.execute('nice -n abc sleep 1')).toContain('invalid adjustment');
  });
});

describe('chrt / ionice / taskset — set then show', () => {
  let exec: LinuxCommandExecutor;
  let pid: string;

  beforeEach(() => {
    exec = new LinuxCommandExecutor(true);
    pid = exec.execute('echo $$').trim();
  });

  it('chrt shows SCHED_OTHER by default and reflects a policy change', () => {
    expect(exec.execute(`chrt -p ${pid}`)).toContain('SCHED_OTHER');
    exec.execute(`chrt -f 50 -p ${pid}`);
    const after = exec.execute(`chrt -p ${pid}`);
    expect(after).toContain('SCHED_FIFO');
    expect(after).toContain('priority: 50');
  });

  it('chrt -m lists the policy priority ranges', () => {
    expect(exec.execute('chrt -m')).toContain('SCHED_FIFO min/max priority');
  });

  it('chrt on an unknown pid reports No such process', () => {
    expect(exec.execute('chrt -p 999999')).toContain('No such process');
  });

  it('ionice shows best-effort by default and reflects a class change', () => {
    expect(exec.execute(`ionice -p ${pid}`)).toContain('best-effort');
    exec.execute(`ionice -c 1 -n 0 -p ${pid}`);
    expect(exec.execute(`ionice -p ${pid}`)).toContain('realtime');
  });

  it('ionice rejects an invalid class', () => {
    expect(exec.execute(`ionice -c 9 -p ${pid}`)).toContain('invalid class');
  });

  it('taskset shows an affinity mask and list', () => {
    expect(exec.execute(`taskset -p ${pid}`)).toContain("current affinity mask");
    expect(exec.execute(`taskset -pc ${pid}`)).toContain("current affinity list");
  });
});

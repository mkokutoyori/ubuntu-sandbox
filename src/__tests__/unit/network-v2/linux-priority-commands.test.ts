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

  it('renice changes a pid niceness and ps reflects it', async () => {
    const pid = (await exec.execute('echo $$')).trim();
    const out = await exec.execute(`renice 5 -p ${pid}`);
    expect(out).toContain(`old priority 0, new priority 5`);
    const ps = await exec.execute(`ps -o pid,ni,comm -p ${pid}`);
    expect(ps).toMatch(/\b5\b/);
  });

  it('renice publishes linux.process.priority-changed', async () => {
    const bus = new EventBus();
    exec.attachEventBus(bus, 'prio-1');
    const seen: number[] = [];
    bus.subscribe('linux.process.priority-changed', e => seen.push(e.payload.newNice));
    const pid = (await exec.execute('echo $$')).trim();
    await exec.execute(`renice 8 -p ${pid}`);
    expect(seen).toContain(8);
  });

  it('renice rejects a non-numeric priority', async () => {
    const pid = (await exec.execute('echo $$')).trim();
    expect(await exec.execute(`renice abc -p ${pid}`)).toContain('invalid priority');
  });

  it('renice on an unknown pid reports No such process', async () => {
    expect(await exec.execute('renice 5 -p 999999')).toContain('No such process');
  });

  it('renice with no argument prints usage', async () => {
    expect(await exec.execute('renice')).toContain('usage');
  });
});

describe('nice', () => {
  it('nice with no command prints the current niceness', async () => {
    const exec = new LinuxCommandExecutor(true);
    expect((await exec.execute('nice')).trim()).toBe('0');
  });

  it('nice -n with an invalid adjustment errors', async () => {
    const exec = new LinuxCommandExecutor(true);
    expect(await exec.execute('nice -n abc sleep 1')).toContain('invalid adjustment');
  });
});

describe('chrt / ionice / taskset — set then show', () => {
  let exec: LinuxCommandExecutor;
  let pid: string;

  beforeEach(async () => {
    exec = new LinuxCommandExecutor(true);
    pid = (await exec.execute('echo $$')).trim();
  });

  it('chrt shows SCHED_OTHER by default and reflects a policy change', async () => {
    expect(await exec.execute(`chrt -p ${pid}`)).toContain('SCHED_OTHER');
    await exec.execute(`chrt -f 50 -p ${pid}`);
    const after = await exec.execute(`chrt -p ${pid}`);
    expect(after).toContain('SCHED_FIFO');
    expect(after).toContain('priority: 50');
  });

  it('chrt -m lists the policy priority ranges', async () => {
    expect(await exec.execute('chrt -m')).toContain('SCHED_FIFO min/max priority');
  });

  it('chrt on an unknown pid reports No such process', async () => {
    expect(await exec.execute('chrt -p 999999')).toContain('No such process');
  });

  it('ionice shows best-effort by default and reflects a class change', async () => {
    expect(await exec.execute(`ionice -p ${pid}`)).toContain('best-effort');
    await exec.execute(`ionice -c 1 -n 0 -p ${pid}`);
    expect(await exec.execute(`ionice -p ${pid}`)).toContain('realtime');
  });

  it('ionice rejects an invalid class', async () => {
    expect(await exec.execute(`ionice -c 9 -p ${pid}`)).toContain('invalid class');
  });

  it('taskset shows an affinity mask and list', async () => {
    expect(await exec.execute(`taskset -p ${pid}`)).toContain("current affinity mask");
    expect(await exec.execute(`taskset -pc ${pid}`)).toContain("current affinity list");
  });
});

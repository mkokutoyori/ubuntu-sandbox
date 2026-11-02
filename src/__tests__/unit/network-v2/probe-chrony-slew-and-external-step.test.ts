/**
 * chronyd moves the clock in two ways and tells them apart from what the operator does to it.
 *
 * Measured on a Linux host synchronised to a Cisco `ntp master` over a cable, after the `makestep 1.0 3` allowance had been used up: when
 * the server's clock jumped by 500 ms, the client's `date` jumped by 350 ms in one second, where chronyd slews at no more than
 * `maxslewrate`; and `chronyc tracking` printed a figure that had nothing to do with the correction still to be applied (0.0047 s in
 * the middle of the slew, 0.0375 s twenty seconds later when nothing was left to apply), because the field was the last estimate instead of
 * the outstanding correction. A `date -s` of an hour forward left `chronyc sourcestats` showing the same 18 samples as before the jump, where
 * chronyd drops them: sched.c reports a wall-clock jump of more than 10 s (JUMP_DETECT_THRESHOLD) as an unknown step, local.c passes it to
 * every source, and sources.c resets each one's statistics.
 *
 * The agent now keeps an outstanding correction. A slew is accrued and applied to the host clock one second at a time at no more than
 * `maxslewrate` (83333 ppm by default: 83.3 ms per second), the agent's own `now()` is the host clock plus what is still outstanding
 * (chronyd's cooked time), and `chronyc tracking` reads that outstanding amount. A step made by someone else beyond 10 s first applies what
 * was outstanding, then forgets the samples; a smaller one is absorbed.
 *
 * Discriminated against the previous state (`git stash` of src/network, the probe kept): 5 of the 7 cases fall — the slew is continuous,
 * tracking shows the outstanding correction, tracking is zero once the slew is done, an external step forgets the samples, and an external
 * step applies the correction in progress. The two that pass either way: the WITNESS (the lab synchronises and tracking is below a
 * millisecond, so a failure elsewhere accuses the clock and not the setup) and the 5-second operator step that must NOT forget anything
 * (non-regression).
 *
 * Known limit: after the allowance is spent chronyd also needs the samples to agree before it slews; a regression over the last samples
 * estimates less than the full jump at the first update (the first update here corrects 350 of 500 ms) and the rest follows with the next
 * polls, as in chronyd. The probe only asserts the part that is certain: the clock approaches the server without a step.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { installVirtualClock, converge } from '../../support/ntpTime';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  clock = installVirtualClock();
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const MAX_SLEW_MS_PER_SECOND = 83.4;

async function lab(): Promise<{ srv: CiscoRouter; pc: LinuxPC }> {
  const srv = new CiscoRouter('SRV');
  for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.100.5 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', 'end']) await srv.executeCommand(line);
  const pc = new LinuxPC('L1');
  new Cable('c1').connect(srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  await pc.executeCommand('ip addr add 192.168.100.9/24 dev eth0');
  await pc.executeCommand("printf 'server 192.168.100.5 iburst\\nmakestep 1.0 3\\n' | sudo tee /etc/chrony/chrony.conf");
  await pc.executeCommand('sudo systemctl restart chrony');
  converge(clock);
  return { srv, pc };
}

const gapMs = (pc: LinuxPC, srv: CiscoRouter): number => pc.getSystemClockMs() - srv.getSystemClockMs();

async function systemTimeSeconds(pc: LinuxPC): Promise<number> {
  const tracking = await pc.executeCommand('chronyc tracking');
  const match = /System time\s*:\s*([0-9.]+) seconds/.exec(tracking);
  if (match === null) throw new Error(`no System time line in:\n${tracking}`);
  return Number(match[1]);
}

async function sourcestatsSamples(pc: LinuxPC): Promise<number> {
  const stats = await pc.executeCommand('chronyc sourcestats');
  const row = stats.split('\n').find((line) => line.startsWith('192.168.100.5'));
  if (row === undefined) throw new Error(`no source row in:\n${stats}`);
  return Number(row.trim().split(/\s+/)[1]);
}

describe('chronyd slews, and tells its own corrections from the operator\'s', () => {
  it('WITNESS: the lab synchronises, tracking is below a millisecond and the source has samples', async () => {
    const { srv, pc } = await lab();
    expect(Math.abs(gapMs(pc, srv))).toBeLessThan(1000);
    expect(await systemTimeSeconds(pc)).toBeLessThan(0.001);
    expect(await sourcestatsSamples(pc)).toBeGreaterThan(0);
  });

  it('a 500 ms jump of the server is followed by slewing: the clock never moves faster than maxslewrate', async () => {
    const { srv, pc } = await lab();
    srv._stepSystemClock(500);
    let previousGap = gapMs(pc, srv);
    let steepest = 0;
    for (let second = 0; second < 12; second++) {
      clock.advance(1000);
      const gap = gapMs(pc, srv);
      steepest = Math.max(steepest, Math.abs(gap - previousGap));
      previousGap = gap;
    }
    expect(steepest).toBeLessThanOrEqual(MAX_SLEW_MS_PER_SECOND);
    expect(Math.abs(previousGap)).toBeLessThan(400);
  });

  it('chronyc tracking reads the correction still to be applied while the clock slews', async () => {
    const { srv, pc } = await lab();
    srv._stepSystemClock(500);
    clock.advance(6000);
    const midSlew = await systemTimeSeconds(pc);
    expect(midSlew).toBeGreaterThan(0.05);
    expect(midSlew).toBeLessThan(0.45);
  });

  it('tracking is back to zero once the slew is done', async () => {
    const { srv, pc } = await lab();
    srv._stepSystemClock(500);
    converge(clock, 20_000);
    expect(await systemTimeSeconds(pc)).toBe(0);
  });

  it('a date -s of an hour forward is an external step: the source forgets its samples', async () => {
    const { pc } = await lab();
    expect(await sourcestatsSamples(pc)).toBeGreaterThan(0);
    await pc.executeCommand(`sudo date -s "@${Math.floor(pc.getSystemClockMs() / 1000) + 3600}"`);
    expect(await sourcestatsSamples(pc)).toBe(0);
  });

  it('a date -s of five seconds is under the jump threshold: the samples are kept', async () => {
    const { pc } = await lab();
    const before = await sourcestatsSamples(pc);
    await pc.executeCommand(`sudo date -s "@${Math.floor(pc.getSystemClockMs() / 1000) + 5}"`);
    expect(await sourcestatsSamples(pc)).toBe(before);
  });

  it('an external step is applied before it is forgotten: the correction in progress does not survive it', async () => {
    const { srv, pc } = await lab();
    srv._stepSystemClock(500);
    clock.advance(6000);
    await pc.executeCommand(`sudo date -s "@${Math.floor(pc.getSystemClockMs() / 1000) + 3600}"`);
    expect(await systemTimeSeconds(pc)).toBe(0);
  });
});

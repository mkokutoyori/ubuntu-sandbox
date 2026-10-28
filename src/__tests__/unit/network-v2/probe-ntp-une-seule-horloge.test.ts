/**
 * A machine has ONE clock. `date`, `Get-Date`, `show clock`, `display clock`, the file stamps and the logs read it; `date -s`, `Set-Date`,
 * `clock set` and `clock datetime` write it. The NTP agent kept a SECOND one: `simulationNowMs() + offsetMs`, a private offset that nothing
 * but the agent itself ever moved.
 *
 * Measured on the NTP lab (srv-ext, two peers, a router, two switches, a domain controller, two PCs, a log server), after every machine
 * had synchronised and the clocks had been skewed by minutes, then by years:
 *  - thirty virtual minutes later every machine still read the skewed time, and `chronyc tracking`, `w32tm /query /status`, `show ntp status`
 *    and `display ntp-service status` all said "synchronised, offset 0": the agent measured the server against ITS clock, which nobody had touched;
 *  - the other direction was as wrong: a client that DID correct an offset moved its private number and left `date` alone;
 *  - `clock datetime` was "Unrecognized command" in the Huawei user view (router and switch), where VRP operators type it (support.huawei.com is
 *    unreachable from this network, so the view is not attested; it stays accepted in system view, where an earlier probe expects it);
 *  - chronyd was given a panic threshold of 1000 s that chronyd does not have (reference.c carries none), so a restarted daemon refused a
 *    gross skew that `makestep 1 3` exists to step; and past its `makestep` updates it HELD a large offset for 300 s before stepping, where
 *    chronyd slews at `maxslewrate` (83333 ppm by default), a directive this parser reported as unknown.
 *
 * The agent now reads the machine's clock and its discipline steps that same clock; a step made by anyone else (the operator) is reported to
 * the agent, which re-expresses what it measured before the step in the new clock, as the step it made itself already did. chronyd counts its
 * `makestep` limit in clock UPDATES (reference.c `is_step_limit_reached`), steps while updates remain and slews otherwise.
 *
 * Discriminated against the previous state (`git stash` of src/network, the probe kept): 16 of the 19 cases fall. The three that pass either
 * way are the two WITNESSES ("the lab agrees with its server before any skew", one per platform family), which prove the lab itself
 * synchronises so that a failure elsewhere accuses the clock and not the setup, and "an operator step is not a discipline step", a
 * non-regression: the applied correction must not move when the operator, not the discipline, moves the clock.
 *
 * Known limit, recorded in TODO.md: the ntpd-family agents (Cisco, Huawei) keep ntpd's 1000 s panic threshold and W32Time its MaxPosPhaseCorrection,
 * so a skew of years is refused there; whether IOS and VRP apply ntpd's threshold is not attested from this network. chronyd has no such refusal.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { parseChronyConf } from '@/network/devices/linux/time/ChronyConfig';
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

let serial = 0;

async function server(): Promise<CiscoRouter> {
  const router = new CiscoRouter(`SRV${++serial}`);
  for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.100.5 255.255.255.0', 'no shutdown', 'exit', 'ntp master 2', 'end']) await router.executeCommand(line);
  return router;
}

async function linuxClient(srv: CiscoRouter): Promise<LinuxPC> {
  const pc = new LinuxPC(`L${++serial}`);
  new Cable(`c${serial}`).connect(srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
  await pc.executeCommand('ip addr add 192.168.100.9/24 dev eth0');
  await pc.executeCommand("printf 'server 192.168.100.5 iburst\\nmakestep 1.0 3\\n' | sudo tee /etc/chrony/chrony.conf");
  await pc.executeCommand('sudo systemctl restart chrony');
  converge(clock);
  return pc;
}

async function windowsClient(srv: CiscoRouter): Promise<WindowsPC> {
  const pc = new WindowsPC('windows-pc', `W${++serial}`);
  pc.setCurrentUser('Administrator');
  new Cable(`c${serial}`).connect(srv.getPort('GigabitEthernet0/0')!, pc.getPorts()[0]);
  await pc.executeCommand('netsh interface ip set address "Ethernet0" static 192.168.100.9 255.255.255.0');
  await pc.executeCommand('w32tm /config /manualpeerlist:"192.168.100.5,0x8" /syncfromflags:manual /reliable:YES /update');
  converge(clock, 300_000);
  return pc;
}

async function ciscoClient(srv: CiscoRouter): Promise<CiscoRouter> {
  const router = new CiscoRouter(`C${++serial}`);
  new Cable(`c${serial}`).connect(srv.getPort('GigabitEthernet0/0')!, router.getPort('GigabitEthernet0/0')!);
  for (const line of ['enable', 'configure terminal', 'interface GigabitEthernet0/0',
    'ip address 192.168.100.9 255.255.255.0', 'no shutdown', 'exit', 'ntp server 192.168.100.5', 'end']) await router.executeCommand(line);
  converge(clock);
  return router;
}

async function huaweiClient(srv: CiscoRouter): Promise<HuaweiRouter> {
  const router = new HuaweiRouter(`H${++serial}`);
  new Cable(`c${serial}`).connect(srv.getPort('GigabitEthernet0/0')!, router.getPort('GE0/0/0')!);
  for (const line of ['system-view', 'interface GigabitEthernet0/0/0', 'ip address 192.168.100.9 255.255.255.0',
    'undo shutdown', 'quit', 'ntp-service unicast-server 192.168.100.5', 'quit']) await router.executeCommand(line);
  converge(clock);
  return router;
}

const machineClockMs = (machine: { getSystemClockMs(): number }): number => machine.getSystemClockMs();
const gapMs = (machine: { getSystemClockMs(): number }, reference: { getSystemClockMs(): number }): number =>
  Math.abs(machineClockMs(machine) - machineClockMs(reference));

const SKEW_MINUTES = 5;

describe('the NTP agent reads and disciplines the clock the machine shows', () => {
  it('WITNESS Linux/chrony: the lab agrees with its server before any skew', async () => {
    const srv = await server();
    const pc = await linuxClient(srv);
    expect(gapMs(pc, srv)).toBeLessThan(1000);
  });

  it('WITNESS Windows/Cisco/Huawei: the lab agrees with its server before any skew', async () => {
    const srv = await server();
    const windows = await windowsClient(srv);
    const cisco = await ciscoClient(srv);
    const huawei = await huaweiClient(srv);
    for (const machine of [windows, cisco, huawei]) expect(gapMs(machine, srv)).toBeLessThan(1000);
  });

  it('a Linux host set wrong with date -s is brought back by chronyd', async () => {
    const srv = await server();
    const pc = await linuxClient(srv);
    await pc.executeCommand(`sudo date -s "@${Math.floor(machineClockMs(pc) / 1000) + SKEW_MINUTES * 60}"`);
    expect(gapMs(pc, srv)).toBeGreaterThan(SKEW_MINUTES * 60_000 - 5000);
    converge(clock, 7_200_000);
    expect(gapMs(pc, srv)).toBeLessThan(1000);
  });

  it('a Windows host set wrong with Set-Date is brought back by W32Time', async () => {
    const srv = await server();
    const pc = await windowsClient(srv);
    const wrong = new Date(machineClockMs(pc) - SKEW_MINUTES * 60_000).toISOString().slice(0, 19).replace('T', ' ');
    await pc.executeCommand(`powershell -c "Set-Date -Date '${wrong}'"`);
    expect(gapMs(pc, srv)).toBeGreaterThan(SKEW_MINUTES * 60_000 - 5000);
    converge(clock, 1_800_000);
    expect(gapMs(pc, srv)).toBeLessThan(1000);
  });

  it('a Cisco router set wrong with clock set is brought back by NTP', async () => {
    const srv = await server();
    const router = await ciscoClient(srv);
    await router.executeCommand('enable');
    const wrong = new Date(machineClockMs(router) + SKEW_MINUTES * 60_000);
    const stamp = `${wrong.toISOString().slice(11, 19)} ${wrong.getUTCDate()} ${wrong.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${wrong.getUTCFullYear()}`;
    await router.executeCommand(`clock set ${stamp}`);
    expect(gapMs(router, srv)).toBeGreaterThan(SKEW_MINUTES * 60_000 - 5000);
    converge(clock, 1_800_000);
    expect(gapMs(router, srv)).toBeLessThan(1000);
  });

  it('a Huawei router set wrong with clock datetime is brought back by NTP', async () => {
    const srv = await server();
    const router = await huaweiClient(srv);
    const wrong = new Date(machineClockMs(router) - SKEW_MINUTES * 60_000);
    await router.executeCommand(`clock datetime ${wrong.toISOString().slice(11, 19)} ${wrong.toISOString().slice(0, 10)}`);
    expect(gapMs(router, srv)).toBeGreaterThan(SKEW_MINUTES * 60_000 - 5000);
    converge(clock, 1_800_000);
    expect(gapMs(router, srv)).toBeLessThan(1000);
  });

  it('after the skew the association view reports the skew, not zero', async () => {
    const srv = await server();
    const router = await ciscoClient(srv);
    await router.executeCommand('enable');
    expect(await router.executeCommand('show ntp associations')).not.toContain('-90000.0');
    router._stepSystemClock(90_000);
    converge(clock, 70_000);
    expect(await router.executeCommand('show ntp associations')).toContain('-90000.0');
  });

  it('the client clock follows its server when the SERVER clock is moved', async () => {
    const srv = await server();
    const router = await ciscoClient(srv);
    srv._stepSystemClock(5_000);
    converge(clock, 1_200_000);
    expect(gapMs(router, srv)).toBeLessThan(100);
    expect(machineClockMs(router) - machineClockMs(srv)).not.toBeGreaterThan(100);
  });

  it('what NTP corrects is visible in the date the machine prints', async () => {
    const srv = await server();
    const pc = await linuxClient(srv);
    srv._stepSystemClock(4_000);
    converge(clock, 3_600_000);
    const printed = Number(await pc.executeCommand('date +%s'));
    expect(Math.abs(printed * 1000 - machineClockMs(srv))).toBeLessThan(1500);
  });

  it('an operator step is not a discipline step: the applied correction does not move', async () => {
    const srv = await server();
    const router = await ciscoClient(srv);
    const appliedBefore = router.getNtpAgent().getOffsetMs();
    router._stepSystemClock(45_000);
    expect(router.getNtpAgent().getOffsetMs()).toBe(appliedBefore);
  });

  it('an operator step re-expresses the offsets already measured', async () => {
    const srv = await server();
    const router = await ciscoClient(srv);
    const association = [...router.getNtpAgent().getConfig().associations.values()][0];
    const measuredBefore = association.offsetMs;
    router._stepSystemClock(45_000);
    expect(association.offsetMs).toBeCloseTo(measuredBefore - 45_000, 0);
  });

  it('the server answers with ITS clock: a skewed server is believed by its client within the discipline limits', async () => {
    const srv = await server();
    const router = await ciscoClient(srv);
    srv._stepSystemClock(700_000);
    converge(clock, 2_400_000);
    expect(gapMs(router, srv)).toBeLessThan(1000);
  });
});

describe('chronyd follows its own rules when the clock is wrong', () => {
  async function skewedByMinutes(minutes: number, extraConf = ''): Promise<{ srv: CiscoRouter; pc: LinuxPC }> {
    const srv = await server();
    const pc = new LinuxPC(`L${++serial}`);
    new Cable(`c${serial}`).connect(srv.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    await pc.executeCommand('ip addr add 192.168.100.9/24 dev eth0');
    await pc.executeCommand(`printf 'server 192.168.100.5 iburst\\nmakestep 1.0 3\\n${extraConf}' | sudo tee /etc/chrony/chrony.conf`);
    await pc.executeCommand('sudo systemctl restart chrony');
    converge(clock);
    await pc.executeCommand(`sudo date -s "@${Math.floor(machineClockMs(pc) / 1000) + minutes * 60}"`);
    return { srv, pc };
  }

  it('past its makestep updates it SLEWS at 83333 ppm instead of waiting for a step', async () => {
    const { srv, pc } = await skewedByMinutes(5);
    const before = gapMs(pc, srv);
    converge(clock, 600_000);
    const corrected = before - gapMs(pc, srv);
    expect(corrected).toBeGreaterThan(30_000);
    expect(corrected).toBeLessThan(70_000);
  });

  it('maxslewrate bounds the slew', async () => {
    const { srv, pc } = await skewedByMinutes(5, 'maxslewrate 1000\\n');
    const before = gapMs(pc, srv);
    converge(clock, 600_000);
    const corrected = before - gapMs(pc, srv);
    expect(corrected).toBeGreaterThan(300);
    expect(corrected).toBeLessThan(1_300);
  });

  it('maxslewrate is a directive chronyd knows', () => {
    const conf = parseChronyConf('server 192.168.100.5\nmaxslewrate 1000\n');
    expect(conf.inconnues).toEqual([]);
    expect(conf.maxSlewRatePpm).toBe(1000);
  });

  it('a restarted chronyd steps whatever the size of the error, there is no panic threshold', async () => {
    const { srv, pc } = await skewedByMinutes(3 * 365 * 24 * 60);
    await pc.executeCommand('sudo systemctl restart chrony');
    converge(clock, 1_800_000);
    expect(gapMs(pc, srv)).toBeLessThan(1000);
  });
});

describe('Huawei: clock datetime is typed in user view', () => {
  it('the router accepts it and display clock follows', async () => {
    const router = new HuaweiRouter(`H${++serial}`);
    expect(await router.executeCommand('clock datetime 10:00:00 2019-03-01')).not.toContain('Unrecognized');
    expect(await router.executeCommand('display clock')).toContain('2019-03-01 10:00:0');
  });

  it('the switch accepts it and display clock follows', async () => {
    const sw = new HuaweiSwitch('switch-huawei', `S${++serial}`);
    expect(await sw.executeCommand('clock datetime 10:00:00 2019-03-01')).not.toContain('Unrecognized');
    expect(await sw.executeCommand('display clock')).toContain('2019-03-01 10:00:0');
  });

  it('a bare clock datetime is incomplete, not silently accepted', async () => {
    const router = new HuaweiRouter(`H${++serial}`);
    expect(await router.executeCommand('clock datetime')).toContain('Incomplete');
  });
});

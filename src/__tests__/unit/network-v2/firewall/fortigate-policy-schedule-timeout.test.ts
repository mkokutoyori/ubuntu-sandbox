/**
 * firewall policy `set schedule-timeout enable`: a session opened inside the
 * policy's schedule is ended when the schedule closes, instead of living on
 * until it is idle. Without the attribute the session outlives the window.
 *
 * Measured on a git worktree of HEAD before the change: the grammar refuses
 * the attribute, so the 1 case that sets it falls (1 of 3). The 2 others are
 * witnesses: the session exists inside the window, and without the attribute
 * it survives the close, which proves the clocks are advanced far enough.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { FortiShell } from '@/network/devices/firewall/vendors/fortios/FortiShell';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '../../../support/ntpTime';

async function runOn(d: { executeCommand(c: string): Promise<string> }, cmds: string[]) {
  for (const c of cmds) await d.executeCommand(c);
}

beforeEach(() => { Logger.reset(); });

async function lab(scheduleTimeout: boolean) {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter();
  const scheduler = installVirtualClock();
  const clock = { value: Date.parse('2026-08-20T12:00:00Z') };
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0, { now: () => clock.value });
  const sh = new FortiShell(fw);
  const pc = new LinuxPC('linux-pc', 'PC', -150, 0);
  const target = new LinuxPC('linux-pc', 'TARGET', 150, 0);
  new Cable('a').connect(pc.getPort('eth0')!, fw.getPort('port1')!);
  new Cable('b').connect(target.getPort('eth0')!, fw.getPort('port2')!);
  for (const line of [
    'config system global', 'set timezone "UTC"', 'end',
    'config system interface', 'edit "port1"', 'set mode static',
    'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit "port2"', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    'config firewall schedule onetime', 'edit "window"',
    'set start 11:00 2026/08/20', 'set end 12:30 2026/08/20', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "port2"',
    'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept',
    'set schedule "window"', ...(scheduleTimeout ? ['set schedule-timeout enable'] : []),
    'next', 'end',
  ]) sh.execute(line);
  await runOn(pc, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.1']);
  await runOn(target, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0',
    'ip route add default via 203.0.113.1']);
  target.getTcpStack().listen(9000, { onAccept: () => undefined });
  pc.getTcpStack().connect('203.0.113.10', 9000);
  const sessions = () => sh.execute('diagnose sys session list');
  const elapse = (minutes: number) => {
    clock.value += minutes * 60_000;
    scheduler.advance(minutes * 60_000);
  };
  return { sessions, elapse };
}

describe('policy schedule-timeout', () => {
  it('witness: the session exists inside the window', async () => {
    const l = await lab(true);
    expect(l.sessions()).toContain('policy_id=1');
  });

  it('witness: without the attribute the session outlives the window', async () => {
    const l = await lab(false);
    l.elapse(45);
    expect(l.sessions()).toContain('policy_id=1');
  });

  it('with the attribute the session ends when the window closes', async () => {
    const l = await lab(true);
    l.elapse(45);
    expect(l.sessions()).not.toContain('policy_id=1');
  });
});

/*
 * Probe: a FortiGate HA pair never elected a primary unless something called HaAgent.tick() by hand: nothing outside the
 * tests did. Built in the simulator as a learner would (two units, a heartbeat cable, `config system ha`), both stayed
 * "Secondary" forever; a secondary is silent on its data interfaces, so the cluster IP never answered ARP and the whole
 * pair forwarded nothing. The heartbeat is documented as hb-interval x 100 ms, default 2 (CLI Reference 7.4.12
 * system ha, p.1600): the firewall now ticks its HA agent on that period while the mode is not standalone, and stops when it
 * returns to standalone.
 *
 * The new primary also announces the cluster address with `arps` gratuitous ARPs, `arps-interval` seconds apart (same page,
 * defaults 5 and 8), so the switches relearn the virtual MAC; observed from the peer, because a unit's sniffer does not show
 * its own transmitted ARP.
 *
 * Discriminated with git stash on src/network: 7 of 8 fall before the fix; the witness (standalone elects nothing, however
 * long the clock runs) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }

async function run(device: Cmd, ...lines: string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

const haLines = (priority: number, mode = 'a-p') => [
  'config system ha', 'set group-id 1', 'set group-name "HA"', `set mode ${mode}`, 'set hbdev "port4" 50',
  `set priority ${priority}`, 'end',
];

async function lab(mode = 'a-p') {
  const clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 8, 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
  for (const device of [a, b, sw, pc]) device.powerOn();
  new Cable('hb').connect(a.getPort('port4')!, b.getPort('port4')!);
  new Cable('pc').connect(pc.getPort('eth0')!, sw.getPort('eth0')!);
  new Cable('a').connect(a.getPort('port1')!, sw.getPort('eth1')!);
  new Cable('b').connect(b.getPort('port1')!, sw.getPort('eth2')!);
  for (const unit of [a, b]) {
    await run(unit, 'config system interface', 'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0',
      'set allowaccess ping', 'next', 'end');
  }
  await run(pc, 'ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1');
  await run(a, ...haLines(200, mode));
  await run(b, ...haLines(100, mode));
  return { a, b, pc, clock };
}

const roleOf = (unit: FortiGate) => unit.getHa().role();

describe('system ha heartbeat clock', () => {
  it('witness: a standalone unit elects nothing however long the clock runs', async () => {
    const { a, clock } = await lab('standalone');
    clock.advance(10_000);
    expect(roleOf(a)).toBe('standalone');
  });

  it('the pair elects the higher priority by itself', async () => {
    const { a, b, clock } = await lab();
    clock.advance(3_000);
    expect([roleOf(a), roleOf(b)]).toEqual(['master', 'slave']);
  });

  it('the cluster address answers a client once the pair has elected', async () => {
    const { pc, clock } = await lab();
    clock.advance(3_000);
    expect(await pc.executeCommand('ping -c 1 -W 1 192.168.1.1')).toContain('1 received');
  });

  it('the survivor takes over when the primary falls silent', async () => {
    const { a, b, clock } = await lab();
    clock.advance(3_000);
    await run(a, 'config system interface', 'edit port4', 'set status down', 'end');
    clock.advance(5_000);
    expect(roleOf(b)).toBe('master');
  });

  it('going back to standalone stops the election', async () => {
    const { a, clock } = await lab();
    clock.advance(3_000);
    expect(roleOf(a)).toBe('master');
    await run(a, 'config system ha', 'set mode standalone', 'end');
    clock.advance(5_000);
    expect(roleOf(a)).toBe('standalone');
  });

  describe('gratuitous ARPs at takeover', () => {
    const sniffedAnnouncements = async (observer: FortiGate) =>
      (await observer.executeCommand("diagnose sniffer packet port1 'arp' 4"))
        .split('\n').filter(line => line.includes('who-has 192.168.1.1 tell 192.168.1.1')).length;

    async function takeover(extra: string[] = []) {
      const { a, b, clock } = await lab();
      if (extra.length > 0) await run(b, 'config system ha', ...extra, 'end');
      clock.advance(3_000);
      await run(a, 'config system interface', 'edit port4', 'set status down', 'end');
      clock.advance(1_500);
      return { a, b, clock };
    }

    it('arps and arps-interval are accepted and bounded as documented', async () => {
      const { a } = await lab();
      await run(a, 'config system ha');
      const accepted = await a.executeCommand('set arps 3');
      const tooMany = await a.executeCommand('set arps 61');
      const tooSlow = await a.executeCommand('set arps-interval 21');
      await run(a, 'end');
      expect(accepted).not.toMatch(/Command fail|unknown/i);
      expect(tooMany).toMatch(/Command fail|range|invalid/i);
      expect(tooSlow).toMatch(/Command fail|range|invalid/i);
    });

    it('the new primary announces its address at once', async () => {
      const { a } = await takeover();
      expect(await sniffedAnnouncements(a)).toBeGreaterThanOrEqual(1);
    });

    it('then repeats it arps times in all, arps-interval seconds apart', async () => {
      const { a, clock } = await takeover(['set arps 3', 'set arps-interval 2']);
      clock.advance(10_000);
      expect(await sniffedAnnouncements(a)).toBe(3);
    });
  });
});

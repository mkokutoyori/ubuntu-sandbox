/**
 * `ping` spaces its echoes by a second, and that second belongs to the
 * simulated clock.
 *
 * Measured: `ping -c 3` cost 2005 ms of wall clock for 13 ms of actual
 * echo, because the interval was a raw `globalThis.setTimeout` — the one
 * wait in the protocol logic that `src/events/Scheduler` did not own, and
 * therefore the one that could not be virtualized. Across the suite that is
 * ~370 multi-echo pings, and it is what put `scenario-cisco-pat-overload`
 * at 4.1 s against vitest's 5 s default, where a loaded run tipped it over.
 *
 * The wait is real behaviour and stays: under the real scheduler a UI
 * terminal still prints one line per second. What changed is only WHOSE
 * clock measures it. Both halves are asserted below, because dropping the
 * wait would be the easy wrong fix — a `ping -c 3` that returns instantly
 * on a real machine would be a worse simulator, not a faster one.
 *
 * Discrimination — restore `Ping.ts`, `LinuxNetKernel.ts` and
 * `LinuxMachine.ts`: both virtual-clock cases fail. Not the way I first
 * wrote here, and the difference is worth keeping: the ping does still
 * settle, because the real timer fires while the driver spins. What it
 * cannot do is settle CHEAPLY — the case measured 2175 ms of wall clock
 * instead of the 156 ms it costs now, and the differential case reads the
 * driver's own spinning rather than the interval. The real-clock control
 * passes either way, and is here to prove the interval was not deleted.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler } from '@/events/Scheduler';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

function twoHosts(): { a: LinuxPC; b: LinuxPC } {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  a.powerOn(); b.powerOn(); sw.powerOn();
  new Cable('c1').connect(a.getPort('eth0')!, sw.getPorts()[0]);
  new Cable('c2').connect(b.getPort('eth0')!, sw.getPorts()[1]);
  const m = new SubnetMask('255.255.255.0');
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), m);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), m);
  return { a, b };
}

function echoCount(output: string): number {
  return output.split('\n').filter((l) => /bytes from /.test(l)).length;
}

describe('the ping interval is measured by the simulated clock', () => {
  it('under a virtual clock the three echoes happen and the wall clock barely moves', async () => {
    const { a } = twoHosts();
    const clock = new VirtualTimeScheduler();
    a.setScheduler(clock);

    const startedAt = Date.now();
    const out = await clock.advanceUntilSettled(a.executeCommand('ping -c 3 10.0.0.2'));
    const wallMs = Date.now() - startedAt;

    expect(echoCount(out)).toBe(3);
    expect(out).toContain('3 packets transmitted, 3 received, 0% packet loss');
    expect(wallMs).toBeLessThan(1000);
  });

  /**
   * The wait still HAPPENS, and `-i` still sizes it — measured as a
   * DIFFERENCE, because a host arms other timers (neighbour cache, DHCP,
   * responders) whose due times the driver also advances through, so the
   * absolute clock reading is not the interval. Two identical labs share
   * those background timers exactly, so what separates the two readings is
   * the interval alone: two gaps, one second each against 200 ms, is
   * 2 × 800 ms.
   */
  it('`-i` shortens the wait by exactly what it says, on the simulated clock', async () => {
    const elapsedFor = async (cmd: string): Promise<number> => {
      const { a } = twoHosts();
      const clock = new VirtualTimeScheduler();
      a.setScheduler(clock);
      const before = clock.now();
      const out = await clock.advanceUntilSettled(a.executeCommand(cmd));
      expect(echoCount(out), cmd).toBe(3);
      return clock.now() - before;
    };

    const defaultInterval = await elapsedFor('ping -c 3 10.0.0.2');
    EquipmentRegistry.resetInstance();
    const shortInterval = await elapsedFor('ping -c 3 -i 0.2 10.0.0.2');

    expect(defaultInterval - shortInterval).toBe(2 * (1000 - 200));
  });

  it('control — on the real clock a ping still takes its seconds, as the UI shows it', async () => {
    const { a } = twoHosts();

    const startedAt = Date.now();
    const out = await a.executeCommand('ping -c 2 10.0.0.2');
    const wallMs = Date.now() - startedAt;

    expect(echoCount(out)).toBe(2);
    expect(wallMs).toBeGreaterThanOrEqual(900);
  }, 15_000);
});

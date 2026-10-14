/**
 * IEEE Std 802.1Q-2022, 11.2: a Linux end station declares the VLAN of a
 * VLAN interface created with `ip link add ... type vlan id N mvrp on`, as an
 * Applicant, and the switch it is cabled to registers it dynamically.
 *
 * Measured on a git worktree of HEAD before the change: `mvrp on` was read as
 * a positional device name and no MRPDU left the host, so the 3 declaring
 * cases fall. The witness (without `mvrp on` the switch never learns the
 * VLAN) passes either way: it proves the registration comes from the option.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { Cable } from '@/network/hardware/Cable';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

function settle(seconds = 40): void {
  for (let i = 0; i < seconds; i++) clock.advance(1000);
}

function lab(): { sw: CiscoSwitch; pc: LinuxPC } {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8);
  const pc = new LinuxPC('linux-pc', 'PC1');
  sw.setSwitchportMode('FastEthernet0/1', 'trunk');
  new Cable('pc-sw').connect(pc.getPort('eth0')!, sw.getPort('FastEthernet0/1')!);
  sw.setMvrpEnabled(true);
  sw.configureMvrpPort('FastEthernet0/1', { enabled: true });
  return { sw, pc };
}

describe('11.2: Linux VLAN interface with mvrp on', () => {
  it('makes the switch create the VLAN', async () => {
    const { sw, pc } = lab();
    await pc.executeCommand('ip link add link eth0 name eth0.100 type vlan id 100 mvrp on');
    settle();
    expect(sw.getVLANs().has(100)).toBe(true);
    expect(sw.isMvrpDynamicVlan(100)).toBe(true);
  });

  it('declares only the VLAN of the interface, not others', async () => {
    const { sw, pc } = lab();
    await pc.executeCommand('ip link add link eth0 name eth0.100 type vlan id 100 mvrp on');
    await pc.executeCommand('ip link add link eth0 name eth0.200 type vlan id 200');
    settle();
    expect(sw.getVLANs().has(200)).toBe(false);
  });

  it('withdraws the VLAN when the interface is deleted', async () => {
    const { sw, pc } = lab();
    await pc.executeCommand('ip link add link eth0 name eth0.100 type vlan id 100 mvrp on');
    settle();
    await pc.executeCommand('ip link del eth0.100');
    settle(60);
    expect(sw.getVLANs().has(100)).toBe(false);
  });

  it('witness: without mvrp on the switch never learns the VLAN', async () => {
    const { sw, pc } = lab();
    await pc.executeCommand('ip link add link eth0 name eth0.100 type vlan id 100');
    settle();
    expect(sw.getVLANs().has(100)).toBe(false);
  });
});

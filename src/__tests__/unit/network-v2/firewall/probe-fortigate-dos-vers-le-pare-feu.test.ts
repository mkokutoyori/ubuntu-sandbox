/*
 * Probe: a DoS-policy protects the firewall itself, not only the traffic it forwards. FortiOS evaluates the policy on
 * ingress, before routing, so an ICMP or SYN flood aimed at an address the unit owns (its WAN interface, its admin
 * port) meets the same anomaly thresholds as one aimed at a server behind it. Measured on the Meridian lab: with
 * `icmp_flood` set to block at 10 per second on wan1, 40 echoes at 10 ms to the unit's own address all came back,
 * while the same burst through the unit was stopped, because the stage sat only on the transit path.
 * Discriminated with git stash on src/network: 1 of 4 falls before the fix (the block). Three pass either way and
 * are named: the two witnesses (no policy, a policy in `pass` action) prove the flood is otherwise delivered, and
 * « the first packets under the threshold are answered » holds before the fix because nothing is dropped at all.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function lab(action: string | null, threshold = 10) {
  const fw = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
  const pc = new LinuxPC('linux-pc', 'PC', 200, 0);
  pc.powerOn();
  new Cable('c').connect(fw.getPort('port1')!, pc.getPorts()[0]);
  const lines = [
    'config system interface', 'edit "port1"', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end',
    ...(action === null ? [] : [
      'config firewall DoS-policy', 'edit 1', 'set interface "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'config anomaly', 'edit "icmp_flood"', 'set status enable', `set action ${action}`, `set threshold ${threshold}`, 'next', 'end', 'next', 'end']),
  ];
  for (const line of lines) await fw.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.1.0.10/24 dev eth0', 'ip route add default via 10.1.0.1']) await pc.executeCommand(line);
  return { fw, pc };
}

const received = (out: string) => Number.parseInt(/(\d+) received/.exec(out)?.[1] ?? '-1', 10);

describe('DoS-policy on traffic addressed to the firewall', () => {
  it('witness: with no policy a burst to the unit is answered in full', async () => {
    const { pc } = await lab(null);
    expect(received(await pc.executeCommand('ping -c 40 -i 0.01 10.1.0.1'))).toBe(40);
  });

  it('witness: a policy in pass action lets the burst through', async () => {
    const { pc } = await lab('pass');
    expect(received(await pc.executeCommand('ping -c 40 -i 0.01 10.1.0.1'))).toBe(40);
  });

  it('a policy in block action stops the burst to the unit itself', async () => {
    const { pc } = await lab('block');
    expect(received(await pc.executeCommand('ping -c 40 -i 0.01 10.1.0.1'))).toBeLessThan(40);
  });

  it('the first packets under the threshold are still answered', async () => {
    const { pc } = await lab('block');
    expect(received(await pc.executeCommand('ping -c 40 -i 0.01 10.1.0.1'))).toBeGreaterThan(0);
  });
});

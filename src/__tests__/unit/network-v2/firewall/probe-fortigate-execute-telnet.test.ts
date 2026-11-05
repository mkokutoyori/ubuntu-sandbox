/*
 * Probe: `execute telnet <dest> [port]` (FortiOS CLI Reference 7.4.12 p.3883) is the operator's TCP reachability
 * test. Measured before: it answered that it needs a console. The connection now crosses the cable as real frames,
 * so a port that nothing listens on is refused and one behind a denying policy times out. The wording of the
 * output follows the BSD telnet client; the reference gives no sample (no transcript available).
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (a host pings its gateway) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { loadAllDevicePlatforms } from '@/network';
import { useNetworkStore } from '@/store/networkStore';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';
import { LabWorkbench } from '@/labs/LabWorkbench';

beforeEach(async () => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); EquipmentRegistry.resetInstance(); Logger.reset();
  await loadAllDevicePlatforms();
  useNetworkStore.getState().clearAll();
});

async function lab() {
  const bench = new LabWorkbench();
  const fgt = bench.place('firewall-fortinet', 'F', 0, 0);
  const srv = bench.place('linux-server', 'SRV', 0, 0);
  const pc = bench.place('linux-pc', 'PC', 0, 0);
  bench.connect(fgt, 'port1', srv, 'eth0');
  bench.connect(fgt, 'port2', pc, 'eth0');
  await bench.shell(fgt, 'config system interface', 'edit port1', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next',
    'edit port2', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'set allowaccess ping', 'next', 'end');
  await bench.shell(srv, 'ip addr add 10.0.0.10/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.0.0.1');
  await bench.shell(pc, 'ip addr add 10.1.0.50/24 dev eth0', 'ip link set eth0 up');
  return { fgt, pc };
}

describe('execute telnet', () => {
  it('witness: a host reaches the FortiGate interface it hangs on', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping -c 1 10.1.0.1')).toContain('1 received');
  });

  it('connects to a listening port', async () => {
    const { fgt } = await lab();
    const out = await fgt.executeCommand('execute telnet 10.0.0.10 22');
    expect(out).toContain('Connected to 10.0.0.10.');
  });

  it('shows the banner the server sends', async () => {
    const { fgt } = await lab();
    expect(await fgt.executeCommand('execute telnet 10.0.0.10 22')).toContain('SSH-2.0');
  });

  it('a closed port is refused', async () => {
    const { fgt } = await lab();
    expect(await fgt.executeCommand('execute telnet 10.0.0.10 9999')).toContain('Connection refused');
  });
});

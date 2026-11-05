/*
 * Probe (found by running `execute ping` and `execute traceroute` on the Meridian hub): a FortiGate could not
 * originate traffic into one of its own IPsec interfaces. The tunnel interface carries no address, the egress
 * source was read from it, and `execute ping 10.1.0.1` answered "No route to destination" while a routed host
 * crossed the same tunnel without trouble; `execute traceroute` answered "unknown host". Real FortiOS sources
 * such traffic from the interface the phase1 is bound to. `get system interface` also listed the tunnel as
 * `type: physical`.
 * Discriminated with git stash on src/network: 3 of 4 fall before the fix; the witness (a host behind the spoke
 * crosses the tunnel) passes either way and proves the tunnel is up.
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
  const hub = bench.place('firewall-fortinet', 'HUB', 0, 0);
  const spoke = bench.place('firewall-fortinet', 'SPOKE', 0, 0);
  const pc = bench.place('linux-pc', 'PC', 0, 0);
  bench.connect(hub, 'wan1', spoke, 'wan1');
  bench.connect(spoke, 'port1', pc, 'eth0');
  const side = (wan: string, peer: string, local: string, remote: string) => [
    'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`, 'next', 'end',
    'config vpn ipsec phase1-interface', 'edit "t"', 'set interface "wan1"', 'set ike-version 2', `set remote-gw ${peer}`,
    'set psksecret sekret123', 'set proposal aes256-sha256', 'next', 'end',
    'config vpn ipsec phase2-interface', 'edit "t"', 'set phase1name "t"', 'set proposal aes256-sha256',
    `set src-subnet ${local}`, `set dst-subnet ${remote}`, 'next', 'end',
  ];
  await bench.shell(hub, ...side('203.0.113.1', '203.0.113.2', '0.0.0.0 0.0.0.0', '0.0.0.0 0.0.0.0'),
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.0.0.1 255.255.255.0', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.1.0.0 255.255.255.0', 'set device "t"', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "t"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end');
  await bench.shell(spoke, ...side('203.0.113.2', '203.0.113.1', '10.1.0.0 255.255.255.0', '0.0.0.0 0.0.0.0'),
    'config system interface', 'edit port1', 'set mode static', 'set ip 10.1.0.1 255.255.255.0', 'next', 'end',
    'config router static', 'edit 1', 'set dst 10.0.0.0 255.0.0.0', 'set device "t"', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "t"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
    'edit 2', 'set srcintf "t"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end');
  await bench.shell(pc, 'ip addr add 10.1.0.50/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.1.0.1');
  return { hub, spoke, pc, bench };
}

describe('traffic a FortiGate originates into its own IPsec interface', () => {
  it('witness: a host behind the spoke crosses the tunnel', async () => {
    const { pc } = await lab();
    await pc.executeCommand('ping -c 1 10.0.0.1');
    expect(await pc.executeCommand('ping -c 2 10.0.0.1')).toContain('2 received');
  });

  it('execute ping from the hub reaches the spoke LAN gateway', async () => {
    const { hub, pc } = await lab();
    await pc.executeCommand('ping -c 1 10.0.0.1');
    expect(await hub.executeCommand('execute ping 10.1.0.1')).toContain('5 packets received');
  });

  it('execute traceroute from the hub does not answer unknown host', async () => {
    const { hub, pc } = await lab();
    await pc.executeCommand('ping -c 1 10.0.0.1');
    expect(await hub.executeCommand('execute traceroute 10.1.0.50')).not.toContain('unknown host');
  });

  it('get system interface lists the tunnel as type tunnel', async () => {
    const { hub } = await lab();
    expect(await hub.executeCommand('get system interface')).toMatch(/name: t .*type: tunnel/);
  });
});

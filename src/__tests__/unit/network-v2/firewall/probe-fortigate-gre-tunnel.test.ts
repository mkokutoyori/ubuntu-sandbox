/*
 * Probe: `config system gre-tunnel` (FortiOS CLI Reference 7.4.12 p.1594) builds a GRE interface (RFC 2784 / 2890)
 * on the shared GRE agent the Linux hosts use: packets routed to it leave as protocol 47 datagrams (real frames
 * on the cable) and the far unit decapsulates them back into its pipeline as traffic arriving on the tunnel.
 * Keys are per direction (key-inbound / key-outbound) and a key that does not match drops the packet.
 * Measured before: "unknown configuration path system gre-tunnel".
 * Discriminated with git stash on src/network: 5 of 7 fall before the fix. The witness (the two units reach each
 * other's WAN address) and the mismatched-key case (nothing arrives for lack of any tunnel) pass either way.
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

interface Keys { outA: number; inA: number; outB: number; inB: number }

async function lab(keys: Keys = { outA: 0, inA: 0, outB: 0, inB: 0 }) {
  const bench = new LabWorkbench();
  const a = bench.place('firewall-fortinet', 'A', 0, 0);
  const b = bench.place('firewall-fortinet', 'B', 0, 0);
  const pcA = bench.place('linux-pc', 'PCA', 0, 0);
  const pcB = bench.place('linux-pc', 'PCB', 0, 0);
  bench.connect(a, 'wan1', b, 'wan1');
  bench.connect(a, 'port1', pcA, 'eth0');
  bench.connect(b, 'port1', pcB, 'eth0');
  const side = (wan: string, peer: string, lan: string, remoteLan: string, tunnelIp: string, remoteTunnel: string, out: number, inn: number) => [
    'config system interface', 'edit wan1', 'set mode static', `set ip ${wan} 255.255.255.0`, 'set allowaccess ping', 'next',
    'edit port1', 'set mode static', `set ip ${lan}.1 255.255.255.0`, 'next', 'end',
    'config system gre-tunnel', 'edit "g"', 'set interface "wan1"', `set remote-gw ${peer}`, `set local-gw ${wan}`,
    ...(out === 0 ? [] : [`set key-outbound ${out}`]), ...(inn === 0 ? [] : [`set key-inbound ${inn}`]), 'next', 'end',
    'config system interface', 'edit "g"', `set ip ${tunnelIp} 255.255.255.255`, `set remote-ip ${remoteTunnel} 255.255.255.255`, 'next', 'end',
    'config router static', 'edit 1', `set dst ${remoteLan}.0 255.255.255.0`, 'set device "g"', 'next', 'end',
    'config firewall policy', 'edit 1', 'set srcintf "port1"', 'set dstintf "g"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next',
    'edit 2', 'set srcintf "g"', 'set dstintf "port1"', 'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"', 'set action accept', 'set schedule "always"', 'next', 'end',
  ];
  const typed = (await bench.shell(a, ...side('203.0.113.1', '203.0.113.2', '10.1.0', '10.2.0', '172.30.0.1', '172.30.0.2', keys.outA, keys.inA)))
    + (await bench.shell(b, ...side('203.0.113.2', '203.0.113.1', '10.2.0', '10.1.0', '172.30.0.2', '172.30.0.1', keys.outB, keys.inB)));
  await bench.shell(pcA, 'ip addr add 10.1.0.50/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.1.0.1');
  await bench.shell(pcB, 'ip addr add 10.2.0.50/24 dev eth0', 'ip link set eth0 up', 'ip route add default via 10.2.0.1');
  return { a, b, pcA, pcB, typed };
}

describe('system gre-tunnel', () => {
  it('witness: the two units reach each other over the WAN link', async () => {
    const { a } = await lab();
    expect(await a.executeCommand('execute ping 203.0.113.2')).toContain('received');
  });

  it('accepts the configuration', async () => {
    const { typed } = await lab();
    expect(typed).not.toMatch(/Command fail|unknown configuration path|unknown attribute/);
  });

  it('a host behind one unit reaches a host behind the other through the tunnel', async () => {
    const { pcA } = await lab();
    expect(await pcA.executeCommand('ping -c 2 10.2.0.50')).toContain('2 received');
  });

  it('the traffic crosses the cable as GRE (protocol 47), counted by the agent', async () => {
    const { a, pcA } = await lab();
    await pcA.executeCommand('ping -c 3 10.2.0.50');
    const tunnel = (a as unknown as { getGreAgent(): { getTunnel(n: string): { packetsOut: number; packetsIn: number } } }).getGreAgent().getTunnel('g');
    expect(tunnel.packetsOut).toBeGreaterThanOrEqual(3);
    expect(tunnel.packetsIn).toBeGreaterThanOrEqual(3);
  });

  it('keys per direction : B sends what A requires, both ways', async () => {
    const { pcA } = await lab({ outA: 200, inA: 100, outB: 100, inB: 200 });
    expect(await pcA.executeCommand('ping -c 2 10.2.0.50')).toContain('2 received');
  });

  it('a key that does not match drops the packets', async () => {
    const { pcA } = await lab({ outA: 200, inA: 100, outB: 100, inB: 999 });
    expect(await pcA.executeCommand('ping -c 2 10.2.0.50')).toContain('0 received');
  });

  it('get system interface lists the tunnel as type tunnel, and the running configuration reproduces it', async () => {
    const { a } = await lab({ outA: 200, inA: 100, outB: 100, inB: 200 });
    expect(await a.executeCommand('get system interface')).toMatch(/name: g .*type: tunnel/);
    const shown = await a.executeCommand('show system gre-tunnel');
    expect(shown).toContain('set key-outbound 200');
    expect(shown).toContain('set remote-gw 203.0.113.2');
  });
});

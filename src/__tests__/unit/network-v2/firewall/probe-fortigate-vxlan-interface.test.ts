/*
 * Probe: FortiOS 7.4.12 (system vxlan, p.2068) documents `config system vxlan` (interface, vni, dstport, remote-ip, ip-version,
 * learn-from-traffic, evpn-id, multicast-ttl). The path did not exist. A VXLAN device is now a virtual interface of the unit:
 * what leaves it (ARP included, flooded to every remote-ip, then unicast once the MAC is learned) is encapsulated by the shared
 * VxlanAgent (RFC 7348) in UDP toward the VTEP, and a datagram for the configured dstport arriving on the underlay interface is
 * decapsulated and handed to the unit as a frame received on that interface. A VXLAN packet whose VNI is not declared is dropped
 * (RFC 7348 §6.1) - the agent used to decapsulate whatever it received. Words the agent cannot honour are refused with the missing
 * brick named: IPv6 and multicast ip-version, evpn-id, multicast-ttl.
 *
 * Two FortiGate face each other on wan1 (203.0.113.1 / .2); each carries vxlan100 with 192.168.100.x on it.
 * Discriminated with git stash on src/network: 6 of 7 fall before the change; the witness (the underlay answers a ping) passes
 * either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function type(device: FortiGate, lines: readonly string[]): Promise<string[]> {
  const replies: string[] = [];
  for (const line of lines) replies.push(await device.executeCommand(line));
  return replies;
}

const vxlanLines = (vni: number, remote: string, extra: readonly string[] = []) => [
  'config system vxlan', 'edit "vxlan100"', 'set interface "wan1"', `set vni ${vni}`, `set remote-ip "${remote}"`, ...extra, 'next', 'end',
];

async function pair(vniA = 1001, vniB = 1001) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('wan1')!, b.getPort('wan1')!);
  const lan = (ip: string, vni: number, remote: string, inner: string) => [
    'config system interface', 'edit "wan1"', 'set mode static', `set ip ${ip} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
    ...vxlanLines(vni, remote),
    'config system interface', 'edit "vxlan100"', 'set mode static', `set ip ${inner} 255.255.255.0`, 'set allowaccess ping', 'next', 'end',
  ];
  await type(a, lan('203.0.113.1', vniA, '203.0.113.2', '192.168.100.1'));
  await type(b, lan('203.0.113.2', vniB, '203.0.113.1', '192.168.100.2'));
  return { a, b };
}

describe('system vxlan', () => {
  it('witness: the underlay answers a ping', async () => {
    const { a } = await pair();
    expect(await a.executeCommand('execute ping 203.0.113.2')).toContain('64 bytes from 203.0.113.2');
  });

  it('the device is accepted and rendered', async () => {
    const { a } = await pair();
    const shown = await a.executeCommand('show system vxlan');
    expect(shown).toContain('set vni 1001');
    expect(shown).toContain('set remote-ip "203.0.113.2"');
  });

  it('a ping crosses the VXLAN between the two inner addresses', async () => {
    const { a } = await pair();
    expect(await a.executeCommand('execute ping 192.168.100.2')).toContain('64 bytes from 192.168.100.2');
  });

  it('the exchange is carried as VXLAN datagrams, ARP included', async () => {
    const { a } = await pair();
    await a.executeCommand('execute ping 192.168.100.2');
    const counters = (a as unknown as { getVxlanAgent(): { listRemoteVteps(): { packetsOut: number; packetsIn: number }[] } })
      .getVxlanAgent().listRemoteVteps();
    expect(counters[0].packetsOut).toBeGreaterThanOrEqual(2);
    expect(counters[0].packetsIn).toBeGreaterThanOrEqual(1);
  });

  it('a VNI the far end does not declare is dropped', async () => {
    const { a } = await pair(1001, 1002);
    expect(await a.executeCommand('execute ping 192.168.100.2')).not.toContain('64 bytes from 192.168.100.2');
  });

  it('two devices cannot carry the same VNI', async () => {
    const { a } = await pair();
    const replies = await type(a, ['config system vxlan', 'edit "other"', 'set interface "wan1"', 'set vni 1001', 'set remote-ip "203.0.113.9"', 'next', 'end']);
    expect(replies.join('\n')).toMatch(/already carried by vxlan100/);
  });

  it('IPv6 and multicast addressing, evpn-id and multicast-ttl are refused naming the missing brick', async () => {
    const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
    const replies = await type(a, ['config system vxlan', 'edit "v"', 'set ip-version ipv6-unicast', 'set evpn-id 5', 'set multicast-ttl 10']);
    expect(replies[2]).toMatch(/IPv4 only/);
    expect(replies[3]).toMatch(/no BGP EVPN control plane/);
    expect(replies[4]).toMatch(/multicast VXLAN is not built/);
  });
});

/*
 * Probe: `ip neigh` on a Linux host listed only the ARP table. The IPv6 neighbour cache (NDP, RFC 4861) that EndHost keeps was
 * invisible, so `ip -6 neigh` printed nothing after a successful ping6, and `ip -4`/`ip -6` did not select a family. iproute2 lists
 * both families by default, `-4` only IPv4 and `-6` only IPv6, an IPv6 entry carrying `router` when the peer advertised itself as
 * one, and `ip -6 neigh show <addr>` filters on an IPv6 address. /proc/net/arp stays IPv4-only.
 * Discriminated with git stash on src/network: 3 of 5 fall before the change; the IPv4 witness and the /proc/net/arp case pass
 * either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); EquipmentRegistry.resetInstance();
});

async function pair() {
  const a = new LinuxPC('linux-pc', 'A', 0, 0);
  const b = new LinuxPC('linux-pc', 'B', 200, 0);
  a.powerOn(); b.powerOn();
  new Cable('c').connect(a.getPorts()[0], b.getPorts()[0]);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0', 'ip -6 addr add 2001:db8::1/64 dev eth0']) await a.executeCommand(line);
  for (const line of ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'ip -6 addr add 2001:db8::2/64 dev eth0']) await b.executeCommand(line);
  await a.executeCommand('ping -c 1 10.0.0.2');
  await a.executeCommand('ping6 -c 1 2001:db8::2');
  return a;
}

describe('ip neigh and the IPv6 neighbour cache', () => {
  it('witness: ip -4 neigh lists the ARP entry', async () => {
    const a = await pair();
    expect(await a.executeCommand('ip -4 neigh')).toMatch(/^10\.0\.0\.2 dev eth0 lladdr \S+ \w+/m);
  });

  it('ip -6 neigh lists the NDP entry learned by ping6', async () => {
    const a = await pair();
    expect(await a.executeCommand('ip -6 neigh')).toMatch(/^2001:db8::2 dev eth0 lladdr \S+ (REACHABLE|STALE|DELAY|PROBE)/m);
  });

  it('ip -6 neigh never lists an IPv4 entry, ip -4 neigh never an IPv6 one', async () => {
    const a = await pair();
    expect(await a.executeCommand('ip -6 neigh')).not.toContain('10.0.0.2');
    expect(await a.executeCommand('ip -4 neigh')).not.toContain('2001:db8::2');
  });

  it('ip neigh without a family lists both', async () => {
    const a = await pair();
    const out = await a.executeCommand('ip neigh');
    expect(out).toContain('10.0.0.2');
    expect(out).toContain('2001:db8::2');
  });

  it('witness: /proc/net/arp stays IPv4-only', async () => {
    const a = await pair();
    const arp = await a.executeCommand('cat /proc/net/arp');
    expect(arp).toContain('10.0.0.2');
    expect(arp).not.toContain('2001:db8');
  });
});

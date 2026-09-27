/*
 * The path MTU a host learns, and what it fragments itself. Read in Linux
 * v6.8: net/ipv4/route.c __ip_rt_update_pmtu (a frag-needed that quotes
 * one of our datagrams creates a per-destination exception, expiring after
 * ip_rt_mtu_expires = 600 s, floored at ip_rt_min_pmtu = 552 and then
 * locked), net/ipv4/ip_output.c (IP_PMTUDISC_WANT sets DF only when the
 * datagram fits the route MTU and fragments it locally otherwise;
 * IP_PMTUDISC_DO fails the send with EMSGSIZE), net/ipv4/icmp.c (the
 * kernel's ICMP socket is IP_PMTUDISC_DONT, so an echo reply leaves with
 * DF clear). iproute2 v6.1.0 ip/iproute.c print_route: "uid N" and a
 * "    cache" line carrying "expires Nsec" and "mtu M". RFC 791 §3.2: a
 * fragment of a fragment keeps MF unless it is the last piece of the
 * original's last fragment. libpcap compiles `icmp` to `ip proto 1`, which
 * a non-first fragment matches.
 *
 * Measured before: every probe of `ping -s 1450` across a 1400-byte hop
 * drew a frag-needed, because the path MTU was never learned; `ip route
 * get` printed no uid and no cache line, and looked the route up in a copy
 * of the kernel's lookup; a router cleared MF on the last piece of a
 * re-fragmented fragment, so the far end answered before the datagram was
 * whole; Linux echo replies copied the request's DF; `tcpdump icmp` hid
 * the fragments after the first.
 *
 * DISCRIMINATION (git stash of src/network): 6 of the 7 cases fall before
 * the change. The witness passes on both trees: a ping that fits the path
 * is answered.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  EquipmentRegistry.resetInstance();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function lab(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('PC1', 0, 0);
  const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
  const router = new CiscoRouter('R1', 50, 0);
  new Cable('a').connect(pc.getPort('eth0')!, router.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(router.getPort('GigabitEthernet0/1')!, srv.getPort('eth0')!);
  for (const c of ['enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 10.0.0.254 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.1.254 255.255.255.0', 'ip mtu 1400', 'no shutdown', 'end']) {
    await router.executeCommand(c);
  }
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc.executeCommand('sudo ip route add default via 10.0.0.254');
  await srv.executeCommand('ifconfig eth0 10.0.1.2 netmask 255.255.255.0');
  await srv.executeCommand('ip route add default via 10.0.1.254');
  return { pc, srv };
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the path MTU is learned from the frag-needed', () => {
  it('only the first probe bounces; the next ones are fragmented and answered', async () => {
    const { pc } = await lab();
    const lines = (await pc.executeCommand('ping -c 3 -i 0.2 -s 1450 10.0.1.2')).split('\n');
    expect(lines[1]).toBe('From 10.0.0.254 icmp_seq=1 Frag needed and DF set (mtu = 1400)');
    expect(lines[2]).toMatch(/^1458 bytes from 10\.0\.1\.2: icmp_seq=2 ttl=63 time=/);
    expect(lines[3]).toMatch(/^1458 bytes from 10\.0\.1\.2: icmp_seq=3 ttl=63 time=/);
  }, 20000);

  it('ip route get shows the exception, and -M do now fails locally against it', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ip route get 10.0.1.2'))
      .toBe('10.0.1.2 via 10.0.0.254 dev eth0 src 10.0.0.1 uid 1000 \n    cache ');
    await pc.executeCommand('ping -c 1 -s 1450 10.0.1.2');
    expect(await pc.executeCommand('ip route get 10.0.1.2'))
      .toMatch(/^10\.0\.1\.2 via 10\.0\.0\.254 dev eth0 src 10\.0\.0\.1 uid 1000 \n {4}cache expires (600|599|598)sec mtu 1400 $/);
    expect((await pc.executeCommand('ping -c 1 -M do -s 1450 10.0.1.2')).split('\n')[1])
      .toBe('ping: local error: message too long, mtu=1400');
  }, 20000);

  it('ip route get of a local address is a local route', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ip route get 10.0.0.1'))
      .toBe('local 10.0.0.1 dev lo table local src 10.0.0.1 uid 1000 \n    cache <local> ');
  });
});

describe('fragments on the wire', () => {
  it('a re-fragmented fragment keeps MF, and the reply follows the last piece', async () => {
    const { pc, srv } = await lab();
    const capture = srv.executeCommand('tcpdump -c 5 -nn -v -i eth0 icmp');
    await settle(30);
    await pc.executeCommand('ping -c 1 -s 2000 10.0.1.2');
    const headers = (await capture).split('\n').filter((l) => /^\d.*IP \(/.test(l));
    expect(headers.map((l) => /offset (\d+), flags \[([^\]]*)\]/.exec(l)!.slice(1).join(' '))).toEqual([
      '0 +', '1376 +', '1480 none', '0 +', '1480 none',
    ]);
  }, 20000);

  it('a Linux echo reply leaves with DF clear', async () => {
    const { pc, srv } = await lab();
    const capture = srv.executeCommand('tcpdump -c 2 -nn -v -i eth0 icmp');
    await settle(30);
    await pc.executeCommand('ping -c 1 10.0.1.2');
    const headers = (await capture).split('\n').filter((l) => /^\d.*IP \(/.test(l));
    expect(headers.map((l) => /flags \[([^\]]*)\]/.exec(l)![1])).toEqual(['DF', 'none']);
  }, 20000);

  it('tcpdump icmp matches the fragments after the first', async () => {
    const { pc, srv } = await lab();
    const capture = srv.executeCommand('tcpdump -c 3 -nn -i eth0 icmp');
    await settle(30);
    await pc.executeCommand('ping -c 1 -s 2000 10.0.1.2');
    expect((await capture).split('\n').filter((l) => l.includes('ip-proto-1'))).toHaveLength(2);
  }, 20000);

  it('witness: a ping that fits the path is answered', async () => {
    const { pc } = await lab();
    expect((await pc.executeCommand('ping -c 1 10.0.1.2')).split('\n')[1]).toMatch(/^64 bytes from 10\.0\.1\.2: icmp_seq=1 ttl=63 time=/);
  });
});

/*
 * nmap against the machine's own addresses. Read in nmap at commit 3be01efb1
 * (7.94): targets.cc:556 (a target whose route goes through a loopback
 * device is marked up with ER_LOCALHOST, no probe sent, and its timeout
 * info is left at initialize_timeout_info's srtt = -1), targets.cc:519 (the
 * ARP ping only runs over ethernet), output.cc:1467 (the latency is printed
 * only when srtt != -1), timing.cc:98 adjust_timeouts2 (the port scan's
 * replies feed srtt), traceroute.cc:1556 (a loopback target is not traced),
 * osscan2.cc:832 (distance 0 for localhost), portreasons.cc:142
 * ("localhost-response"). On Linux, a packet to one of the host's own
 * addresses is routed through lo, and an ICMP error about it comes back
 * through lo as well. arp_ignore = 0 (the value /proc already shows) answers
 * ARP for every local address, secondary ones included.
 *
 * Measured before: `sudo nmap -sn 10.0.0.1` on 10.0.0.1 sent an ARP request
 * to itself and printed "Host seems down", even under -Pn; 127.0.0.1
 * reported "received echo-reply ttl 64"; a host with no measured round trip
 * printed "(0.0000010s latency)"; `-sU` against the own address said
 * open|filtered for a closed port; a secondary address was unreachable from
 * the segment because nothing answered ARP for it, and `traceroute -s` with
 * it was refused as "Cannot assign requested address".
 *
 * DISCRIMINATION (git stash of src/network): 8 of the 10 cases fall before
 * the change. The two that pass on both trees are witnesses: an
 * unprivileged scan of the own address goes through connect() and never
 * took the broken ARP path, and a remote host still answers ARP with its
 * MAC line.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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
  new Cable('c1').connect(pc.getPort('eth0')!, srv.getPort('eth0')!);
  await pc.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { pc, srv };
}

const body = (out: string) => out.split('\n').slice(1);

describe('root scanning its own address goes through lo', () => {
  it('-sn: up by localhost-response, no probe on the wire, no latency', async () => {
    const { srv } = await lab();
    expect(body(await srv.executeCommand('nmap -sn --reason --packet-trace 10.0.0.2'))).toEqual([
      'Nmap scan report for 10.0.0.2',
      'Host is up, received localhost-response.',
      '',
      'Nmap done: 1 IP address (1 host up) scanned in 0.05 seconds',
    ]);
  });

  it('a port scan measures the round trip from its replies', async () => {
    const { srv } = await lab();
    const out = await srv.executeCommand('nmap --reason -p 22 10.0.0.2');
    expect(out).toMatch(/\nHost is up, received localhost-response \(\d\.\d+s latency\)\.\nPORT {3}STATE SERVICE REASON\n22\/tcp open {2}ssh {5}syn-ack\n/);
  });

  it('-O and --traceroute: distance 0, no trace, no MAC line', async () => {
    const { srv } = await lab();
    const out = await srv.executeCommand('nmap -O --traceroute -p 22 10.0.0.2');
    expect(out).toContain('Network Distance: 0 hops');
    expect(out).not.toContain('TRACEROUTE');
    expect(out).not.toContain('MAC Address');
  });

  it('127.0.0.1 is reached the same way', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('nmap -sn --reason 127.0.0.1'))
      .toContain('Nmap scan report for localhost (127.0.0.1)\nHost is up, received localhost-response.\n');
  });

  it('-sU: the port unreachable comes back through lo and closes the port', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('nmap -sU --reason -p 53 10.0.0.2'))
      .toMatch(/\n53\/udp closed domain {2}port-unreach\n/);
  });

  it('Windows scans its own address the same way', async () => {
    const win = new WindowsPC('windows-pc', 'WIN', 0, 0);
    const srv = new LinuxServer('linux-server', 'SRV', 100, 0);
    new Cable('c1').connect(win.getPort('eth0')!, srv.getPort('eth0')!);
    await win.executeCommand('netsh interface ip set address "Ethernet" static 10.0.0.5 255.255.255.0');
    expect(await win.executeCommand('nmap -sn --reason 10.0.0.5'))
      .toContain('\nHost is up, received localhost-response.\n');
  });

  it('witness: unprivileged, the same scan is a connect() ping with a latency', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nmap -sn 10.0.0.1')).toMatch(/\nHost is up \(\d\.\d+s latency\)\.\n/);
  });
});

describe('a host with no measured round trip prints no latency', () => {
  it('-Pn -sn without the ARP ping: "Host is up." and srtt -1 in XML', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('nmap -sn -Pn --disable-arp-ping 10.0.0.1'))
      .toContain('\nNmap scan report for 10.0.0.1\nHost is up.\n');
    await srv.executeCommand('nmap -sn -Pn --disable-arp-ping -oX /tmp/x.xml 10.0.0.1');
    expect(await srv.executeCommand('cat /tmp/x.xml')).toContain('<times srtt="-1" rttvar="-1" to="1000000"/>');
  });

  it('witness: a remote host answers the ARP ping and carries its MAC', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('nmap -sn --reason 10.0.0.1'))
      .toMatch(/\nHost is up, received arp-response \(\d\.\d+s latency\)\.\nMAC Address: /);
  });
});

describe('a secondary address answers ARP (arp_ignore = 0)', () => {
  it('the neighbour reaches it, and traceroute -s uses it', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand('sudo ip addr add 10.0.0.9/24 dev eth0');
    expect(await srv.executeCommand('ping -c 1 10.0.0.9')).toContain('1 packets transmitted, 1 received');
    expect((await pc.executeCommand('traceroute -n -q 1 -m 1 -s 10.0.0.9 10.0.0.2')).split('\n')[1])
      .toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/);
  });
});

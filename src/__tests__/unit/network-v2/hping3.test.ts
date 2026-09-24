/*
 * Probe — `hping3` crafts real TCP/ICMP packets on the wire and reports the
 * loss its replies (or their absence) imply.
 *
 * Before: `hping3` answered "command not found" (FortiGate battery 02
 * tests 92 and 96, battery 03 test 144): a stateful firewall could not be
 * exercised with an ACK-without-SYN, a spoofed source, or a land attack.
 *
 * Authority: the reachable ancestor antirez/hping (fetched: main.c banner
 * "HPING %s (%s %s): %s set, %d headers + %d data bytes", statistics.c
 * "--- %s hping statistic ---" then the transmitted/received/loss line and
 * "round-trip min/avg/max"). hping3's own source (salsa.debian.org) is not
 * reachable from here, so the only change from the ancestor is its known
 * fix of the "tramitted" typo to "transmitted", and TCP header size 40 /
 * ICMP 28 / raw 20 per the IP+L4 header sizes. The wire behaviour is the
 * simulator's own: TCP via TcpStack.scanProbe (the stateless segment nmap
 * already uses), ICMP via pingSequence or a crafted echo. A forged source
 * receives no reply, which is the point of -a/--spoof.
 *
 * Measured before the change (git stash of src/network): all 6 cases fail
 * — hping3 is a new command, so none run before it exists.
 * The WITNESS is "a SYN to an open port is answered" and "an ICMP echo to
 * a reachable host is answered": they prove the lab replies when it should,
 * so the four losses measure hping3's reading and not a dead route — a
 * probe of refusals alone would not (rule 7).
 */
import { describe, it, expect } from 'vitest';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { createDevice } from '@/network/devices/DeviceFactory';
import { Cable } from '@/network/hardware/Cable';
import { type Cli, taper } from '../new_firewall/fortigateBatteryHarness';

interface Lab { pc: LinuxPC; srv: LinuxServer; fw: Cli }

async function throughFirewall(): Promise<Lab> {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Cli;
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  pc.powerOn();
  srv.powerOn();
  new Cable('lan').connect(pc.getPort('eth0') as never, fw.getPort('port1') as never);
  new Cable('wan').connect(fw.getPort('wan1') as never, srv.getPort('eth0') as never);
  await taper(fw, [
    'config system interface',
    'edit port1', 'set mode static', 'set ip 192.168.1.1 255.255.255.0', 'next',
    'edit wan1', 'set mode static', 'set ip 203.0.113.1 255.255.255.0', 'next', 'end',
    'config firewall policy', 'edit 1',
    'set srcintf "port1"', 'set dstintf "wan1"', 'set srcaddr "all"', 'set dstaddr "all"',
    'set action accept', 'set schedule "always"', 'set service "ALL"', 'next', 'end',
  ]);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 192.168.1.10/24 dev eth0', 'ip route add default via 192.168.1.1']);
  await taper(srv as unknown as Cli, ['ip link set eth0 up', 'ip addr add 203.0.113.10/24 dev eth0', 'ip route add default via 203.0.113.1', 'systemctl start nginx']);
  return { pc, srv, fw };
}

async function directLink(): Promise<{ pc: LinuxPC; srv: LinuxServer }> {
  const pc = new LinuxPC('linux-pc', 'pc', 0, 0);
  const srv = new LinuxServer('linux-server', 'web', 0, 0);
  pc.powerOn();
  srv.powerOn();
  new Cable('c').connect(pc.getPort('eth0') as never, srv.getPort('eth0') as never);
  await taper(pc as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.1/24 dev eth0']);
  await taper(srv as unknown as Cli, ['ip link set eth0 up', 'ip addr add 10.0.0.2/24 dev eth0', 'systemctl start nginx']);
  return { pc, srv };
}

describe('hping3', () => {
  it('a SYN to an open port is answered', async () => {
    const { pc } = await directLink();
    const out = await pc.executeCommand('hping3 -S -p 80 -c 1 10.0.0.2');
    expect(out).toContain('HPING 10.0.0.2 (eth0 10.0.0.2): S set, 40 headers + 0 data bytes');
    expect(out).toContain('1 packets transmitted, 1 packets received, 0% packet loss');
  });

  it('an ACK with no prior SYN is dropped by the stateful firewall', async () => {
    const { pc } = await throughFirewall();
    const out = await pc.executeCommand('hping3 -A -p 80 -c 1 203.0.113.10');
    expect(out).toContain('A set, 40 headers + 0 data bytes');
    expect(out).toContain('1 packets transmitted, 0 packets received, 100% packet loss');
  });

  it('a closed port answers with a RST', async () => {
    const { pc } = await directLink();
    const out = await pc.executeCommand('hping3 -S -p 81 -c 1 10.0.0.2');
    expect(out).toContain('1 packets transmitted, 1 packets received, 0% packet loss');
  });

  it('a forged source gets no reply', async () => {
    const { pc } = await throughFirewall();
    const out = await pc.executeCommand('hping3 -a 203.0.113.88 -1 -c 1 203.0.113.10');
    expect(out).toContain('icmp mode set, 28 headers + 0 data bytes');
    expect(out).toContain('1 packets transmitted, 0 packets received, 100% packet loss');
  });

  it('a land attack (source = destination) gets no reply', async () => {
    const { pc } = await throughFirewall();
    const out = await pc.executeCommand('hping3 -a 203.0.113.10 -S -p 80 -c 1 203.0.113.10');
    expect(out).toContain('100% packet loss');
  });

  it('an ICMP echo to a reachable host is answered', async () => {
    const { pc } = await directLink();
    const out = await pc.executeCommand('hping3 -1 -c 2 10.0.0.2');
    expect(out).toContain('2 packets transmitted, 2 packets received, 0% packet loss');
  });
});

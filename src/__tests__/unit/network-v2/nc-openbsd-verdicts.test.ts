/*
 * nc read against OpenBSD netcat.c 1.239 (main's getopt and port loop,
 * build_ports, strtoport, remote_connect, udptest, connection_info,
 * local_listen's "Bound"/"Listening") and the Linux kernel v6.8
 * (net/ipv4/icmp.c icmp_err_convert, net/ipv4/udp.c __udp4_lib_err, which
 * records a FATAL ICMP error on a connected UDP socket, and
 * sock_alloc_send_pskb, which hands it to the next send). A neighbour that
 * never answers ARP fails connect() with EHOSTUNREACH. Debian's patch set
 * is not reachable from here; the verdicts below agree between OpenBSD's
 * udptest and the frame-synchronous simulator.
 *
 * Measured before: every UDP probe "succeeded", a closed local port
 * included; the exit status was always 0; the service printed as
 * "[tcp/*]" and a name never carried its address; a port range stopped
 * at its first port; an absent LAN host failed in getaddrinfo; `-zvw1`
 * printed the SSH banner; `-s` was taken for the destination; `nc -lu`
 * bound nothing a datagram could reach; `2>&1 |` printed stderr twice.
 *
 * DISCRIMINATION (git stash of src/network, src/bash, src/terminal): 8 of the 10 cases
 * fall before the change. Two pass on both trees: the open UDP port is a
 * witness (the old nc said "succeeded" to every UDP port), and `nc host
 * 22` still prints the SSH banner through one connection.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
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

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('UDP: the port unreachable reaches the connected socket', () => {
  it('a closed remote port and a closed local port fail silently with status 1', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zvu 10.0.0.2 9999; echo rc=$?')).toBe('rc=1');
    expect(await pc.executeCommand('nc -zvu 127.0.0.1 9999; echo rc=$?')).toBe('rc=1');
  });

  it('witness: a port nc -lu really bound answers nothing and succeeds', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('nc -lu -p 9000 &');
    expect(await pc.executeCommand('nc -zvu 10.0.0.2 9000; echo rc=$?'))
      .toBe('Connection to 10.0.0.2 9000 port [udp/*] succeeded!\nrc=0');
  });
});

describe('TCP verdicts and their words', () => {
  it('the service name, and the address after a name', async () => {
    const { pc } = await lab();
    await pc.executeCommand("sudo sh -c 'echo 10.0.0.2 srv >> /etc/hosts'");
    expect(await pc.executeCommand('nc -zv srv 22')).toBe('Connection to srv (10.0.0.2) 22 port [tcp/ssh] succeeded!');
    expect(await pc.executeCommand('nc -zvn 10.0.0.2 22')).toBe('Connection to 10.0.0.2 22 port [tcp/*] succeeded!');
    expect(await pc.executeCommand('nc -zvn srv 22')).toBe('nc: getaddrinfo for host "srv" port 22: Name or service not known');
  });

  it('a range tries every port, and one success is status 0', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zv 10.0.0.2 21-22; echo rc=$?')).toBe(
      'nc: connect to 10.0.0.2 port 21 (tcp) failed: Connection refused\n'
      + 'Connection to 10.0.0.2 22 port [tcp/ssh] succeeded!\nrc=0');
    expect(await pc.executeCommand('nc -z 10.0.0.2 9; echo rc=$?')).toBe('rc=1');
  });

  it('an absent neighbour is EHOSTUNREACH, for nc and nmap alike', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zv 10.0.0.77 22; echo rc=$?'))
      .toBe('nc: connect to 10.0.0.77 port 22 (tcp) failed: No route to host\nrc=1');
    expect(await pc.executeCommand('nmap -Pn -sT --reason -p 22 10.0.0.77')).toContain('\n22/tcp filtered ssh     host-unreach\n');
  });

  it('-s binds the source: an address of the machine goes on the wire, another cannot be assigned', async () => {
    const { pc, srv } = await lab();
    await pc.executeCommand('sudo ip addr add 10.0.0.9/24 dev eth0');
    const capture = srv.executeCommand('tcpdump -c 1 -nn -i eth0 tcp');
    await settle(30);
    expect(await pc.executeCommand('nc -zv -s 10.0.0.9 10.0.0.2 22')).toBe('Connection to 10.0.0.2 22 port [tcp/ssh] succeeded!');
    expect(await capture).toMatch(/IP 10\.0\.0\.9\.\d+ > 10\.0\.0\.2\.22: Flags \[S\]/);
    expect(await pc.executeCommand('nc -zv -s 10.0.0.66 10.0.0.2 22')).toBe('nc: bind failed: Cannot assign requested address');
  });

  it('witness: without -z the service greeting is printed', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc 10.0.0.2 22')).toMatch(/^SSH-2\.0-OpenSSH/);
  });
});

describe('getopt and the two streams', () => {
  it('-zvw1 is three options, and an unknown one prints the usage', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zvw1 10.0.0.2 22')).toBe('Connection to 10.0.0.2 22 port [tcp/ssh] succeeded!');
    expect(await pc.executeCommand('nc --help')).toMatch(/^nc: invalid option -- '-'\nusage: nc \[-46cDdFhklNnrStUuvz\]/);
    expect(await pc.executeCommand('nc -zv 10.0.0.2 99999; echo rc=$?')).toBe('nc: port number too large: 99999\nrc=1');
  });

  it('the messages are on fd 2: 2>/dev/null hides them, 2>&1 | feeds them once', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zv 10.0.0.2 22 2>/dev/null; echo rc=$?')).toBe('rc=0');
    expect(await pc.executeCommand('nc -zv 10.0.0.2 22 2>&1 | grep -c succeeded')).toBe('1');
  });

  it('2>&1 >file sends fd 2 to the pipe and fd 1 to the file', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zv 10.0.0.2 22 2>&1 >/tmp/o | tr a-z A-Z'))
      .toBe('CONNECTION TO 10.0.0.2 22 PORT [TCP/SSH] SUCCEEDED!');
  });
});

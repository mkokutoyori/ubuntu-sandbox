/*
 * ping, one runner for the command, the terminal and the SSH shell, read
 * against iputils 20221126 (ping/ping.c, ping/ping_common.c,
 * iputils_common.c): -I takes an address (bind, "from <src> :") or a
 * device (SO_BINDTODEVICE, "from <src> <dev>:"); getopt, strtol_or_err and
 * ping_strtod word the refusals; MINUSERINTERVAL is 2 ms and setup() refuses
 * a user flood AFTER the header; connect() refuses a broadcast without -b;
 * finish() prints the loss with %g and gather_statistics() prints time= with
 * 3, 2, 1 or 0 decimals; a probe that gets no answer prints nothing; one
 * socket keeps one ICMP identifier while the sequence climbs.
 *
 * Measured before: -I refused any address as "invalid argument — device
 * not found" and ignored a device; the terminal never checked -I, -f or the
 * interval and wrote "Request timeout for icmp_seq N"; a user was refused
 * -i 0.1; every probe of the command carried icmp_seq 1 and a new id on the
 * wire; the loss was rounded to an integer.
 *
 * DISCRIMINATION (git stash of src/network, src/terminal): 12 of the 13
 * cases fall before the change. The witness passes on both trees: a plain
 * ping of a neighbour still prints its header and a reply.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import * as Format from '@/network/devices/linux/LinuxFormatHelpers';
import type { PingResult } from '@/network/devices/EndHost';

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
  await pc.executeCommand('sudo ip addr add 10.0.0.9/24 dev eth0');
  await pc.executeCommand('sudo ip addr add 192.168.5.1/24 dev eth1');
  await srv.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { pc, srv };
}

const key = (k: string, ctrlKey = false) => ({ key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false });
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function inTerminal(pc: LinuxPC, command: string, waitMs: number, interrupt = false): Promise<string[]> {
  pc.powerOn();
  const session = new LinuxTerminalSession('t', pc);
  const before = session.lines.length;
  session.setInput(command);
  session.handleKey(key('Enter'));
  await settle(waitMs);
  if (interrupt) { session.handleKey(key('c', true)); await settle(50); }
  return session.lines.slice(before + 1).map((l) => l.text);
}

describe('-I binds an address or a device', () => {
  it('an address of the machine becomes the source on the wire and in the header', async () => {
    const { pc, srv } = await lab();
    const capture = srv.executeCommand('tcpdump -c 1 -nn -i eth0 icmp');
    await settle(30);
    const out = await pc.executeCommand('ping -c 1 -I 10.0.0.9 10.0.0.2');
    expect(out.split('\n')[0]).toBe('PING 10.0.0.2 (10.0.0.2) from 10.0.0.9 : 56(84) bytes of data.');
    expect(await capture).toMatch(/IP 10\.0\.0\.9 > 10\.0\.0\.2: ICMP echo request/);
  });

  it('an address the machine does not own cannot be bound', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping -c 1 -I 10.0.0.77 10.0.0.2')).toBe('ping: bind: Cannot assign requested address');
  });

  it('a device: unknown is refused by SO_BINDTODEVICE, known names itself, and routes only through itself', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping -c 1 -I eth9 10.0.0.2')).toBe('ping: SO_BINDTODEVICE eth9: No such device');
    expect((await pc.executeCommand('ping -c 1 -I eth0 10.0.0.2')).split('\n')[0])
      .toBe('PING 10.0.0.2 (10.0.0.2) from 10.0.0.1 eth0: 56(84) bytes of data.');
    expect(await pc.executeCommand('ping -c 1 -I eth1 10.0.0.2')).toBe('ping: connect: Network is unreachable');
  });
});

describe('the refusals are iputils own words', () => {
  it('a user may go down to 2 ms, a user flood is refused after the header', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping -c 2 -i 0.1 10.0.0.2')).toMatch(/\n2 packets transmitted, 2 received, 0% packet loss/);
    expect(await pc.executeCommand('ping -f -c 2 10.0.0.2')).toBe(
      'PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.\nping: cannot flood; minimal interval allowed for user is 2ms');
  });

  it('numbers, -M and a broadcast', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping -c 0 10.0.0.2'))
      .toBe("ping: invalid argument: '0': out of range: 1 <= value <= 9223372036854775807");
    expect(await pc.executeCommand('ping -t 300 10.0.0.2'))
      .toBe("ping: invalid argument: '300': out of range: 0 <= value <= 255");
    expect(await pc.executeCommand('ping -M foo 10.0.0.2')).toBe('ping: invalid -M argument: foo');
    expect(await pc.executeCommand('ping -c 1 10.0.0.255'))
      .toBe('ping: Do you want to ping broadcast? Then -b. If not, check your local firewall rules');
  });

  it('getopt: no destination, an unknown option, -V', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping')).toBe('ping: usage error: Destination address required');
    expect(await pc.executeCommand('ping -z 10.0.0.2')).toMatch(/^ping: invalid option -- 'z'\n\nUsage\n {2}ping \[options\] <destination>/);
    expect(await pc.executeCommand('ping -V')).toBe('ping from iputils 20221126');
  });
});

describe('what a run prints', () => {
  it('a name is printed as name (address) on every reply and labels the statistics', async () => {
    const { pc } = await lab();
    await pc.executeCommand("sudo sh -c 'echo 10.0.0.2 srv >> /etc/hosts'");
    const out = await pc.executeCommand('ping -c 1 srv');
    expect(out).toMatch(/^PING srv \(10\.0\.0\.2\) 56\(84\) bytes of data\.\n64 bytes from srv \(10\.0\.0\.2\): icmp_seq=1 ttl=64 time=/);
    expect(out).toContain('\n--- srv ping statistics ---\n');
  });

  it('under 16 data bytes there is no timing', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('ping -c 1 -s 8 10.0.0.2')).toBe(
      'PING 10.0.0.2 (10.0.0.2) 8(36) bytes of data.\n16 bytes from 10.0.0.2: icmp_seq=1 ttl=64\n\n'
      + '--- 10.0.0.2 ping statistics ---\n1 packets transmitted, 1 received, 0% packet loss, time 0ms\n');
  });

  it('one identifier for the run, and the sequence climbs on the wire', async () => {
    const { pc, srv } = await lab();
    const capture = srv.executeCommand('tcpdump -c 3 -nn -i eth0 icmp');
    await settle(30);
    await pc.executeCommand('ping -c 2 -i 0.2 10.0.0.2');
    const lines = (await capture).split('\n').filter((l) => l.includes('echo request'));
    const ids = lines.map((l) => /id (\d+), seq (\d+)/.exec(l)!.slice(1));
    expect(ids.map((x) => x[1])).toEqual(['1', '2']);
    expect(ids[0][0]).toBe(ids[1][0]);
  });

  it('%g loss and the time precision of gather_statistics', () => {
    const ok = (seq: number, rttMs: number): PingResult => ({ success: true, rttMs, ttl: 64, seq, bytes: 64, fromIP: '10.0.0.2' });
    const lost = (seq: number): PingResult => ({ success: false, rttMs: 0, ttl: 0, seq, bytes: 0, fromIP: '' });
    expect(Format.formatPingStats('h', 3, [ok(1, 0.5), lost(2), lost(3)], 2002)[2])
      .toBe('3 packets transmitted, 1 received, 66.6667% packet loss, time 2002ms');
    expect([0.647, 2.648, 12.34, 150.4].map((ms) => Format.formatPingRtt(ms))).toEqual(['0.647', '2.65', '12.3', '150']);
  });

  it('witness: a plain ping of a neighbour', async () => {
    const { pc } = await lab();
    const out = (await pc.executeCommand('ping -c 1 10.0.0.2')).split('\n');
    expect(out[0]).toBe('PING 10.0.0.2 (10.0.0.2) 56(84) bytes of data.');
    expect(out[1]).toMatch(/^64 bytes from 10\.0\.0\.2: icmp_seq=1 ttl=64 time=/);
  });
});

describe('the terminal runs the same runner', () => {
  it('it refuses what the command refuses', async () => {
    const { pc } = await lab();
    expect(await inTerminal(pc, 'ping -c 1 -I 10.0.0.77 10.0.0.2', 200)).toEqual(['ping: bind: Cannot assign requested address']);
  });

  it('a silent probe prints nothing, and Ctrl+C prints the statistics right under ^C', async () => {
    const { pc, srv } = await lab();
    await srv.executeCommand('iptables -A INPUT -p icmp -j DROP');
    const lines = await inTerminal(pc, 'ping -W 0.1 -i 0.2 10.0.0.2', 700, true);
    expect(lines.some((l) => /Request timeout|icmp_seq/.test(l))).toBe(false);
    const caret = lines.indexOf('^C');
    expect(lines[caret + 1]).toBe('--- 10.0.0.2 ping statistics ---');
    expect(lines[caret + 2]).toMatch(/^\d+ packets transmitted, 0 received, 100% packet loss, time \d+ms$/);
  });
});

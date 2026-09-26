/*
 * CAP_NET_RAW: what an unprivileged user may and may not do with the four
 * tools that open raw or packet sockets, on Ubuntu 22.04. A LinuxPC runs as
 * `user` (uid 1000, in `sudo`); a LinuxServer runs as root.
 *
 * Measured before the change: `user` could capture with tcpdump, trace
 * with `-T`/`-P`, run `nmap -sS -O --traceroute` and hping3 exactly as
 * root, and nmap chose the CONNECT scan for everybody, root included,
 * printing `reset` where connect() reports `conn-refused`.
 *
 * Sources, read in the upstream trees:
 *  - libpcap-1.10.1 pcap-linux.c (socket(PF_PACKET) failing EPERM is
 *    PCAP_ERROR_PERM_DENIED), pcap.c pcap_statustostr, tcpdump-4.99.1
 *    tcpdump.c ("%s: %s\n(%s)"); `-D` needs no socket and still lists;
 *  - traceroute-2.1.0 mod-tcp.c / mod-raw.c (SOCK_RAW, error_or_perm) and
 *    mod-icmp.c (falls back to an unprivileged SOCK_DGRAM, which Ubuntu's
 *    ping_group_range allows), traceroute.c error_or_perm/error;
 *  - nmap NmapOps.cc (isr00t from geteuid, SYN by default only for root,
 *    ValidateOptions' fatals), nmap.cc (validate_scan_lists' TCP pingscan
 *    fallback, `-A` enabling -O/--traceroute only for root, the traceroute
 *    fatal after the banner, the raw-options warning after it too),
 *    targets.cc:284 (ARP discovery only as root, so no MAC line),
 *    scan_engine_connect.cc + portreasons.cc (`conn-refused`);
 *  - hping3 main.c / opensockraw.c (`using ...` under -V, then perror and
 *    "[main] can't open raw socket"; `Scanning ...` before scan mode).
 *
 * DISCRIMINATION (git stash of src/network, src/terminal): 11 of the 15
 * cases fall before the change. Four pass on both trees and are witnesses
 * that the lab answers and that nothing unprivileged was taken away:
 * `sudo tcpdump` capturing, `tcpdump -D` and `-r` for `user`, the UDP and
 * ICMP traceroutes for `user`, and root's hping3.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { LinuxTerminalSession } from '@/terminal/sessions/LinuxTerminalSession';
import type { KeyEvent } from '@/terminal/sessions/TerminalSession';

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

const NO_CAPTURE = "tcpdump: eth0: You don't have permission to capture on that device\n(socket: Operation not permitted)";
const NO_RAW_TRACE = 'You do not have enough privileges to use this traceroute method.\nsocket: Operation not permitted';

describe('tcpdump — a packet socket needs CAP_NET_RAW', () => {
  it('user is refused on a device, on any and for -L, in libpcap\'s words', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('tcpdump -c 1 -i eth0')).toBe(NO_CAPTURE);
    expect(await pc.executeCommand('tcpdump -c 1')).toBe(NO_CAPTURE);
    expect(await pc.executeCommand('tcpdump -i any -c 1')).toBe(NO_CAPTURE.replace('eth0', 'any'));
    expect(await pc.executeCommand('tcpdump -L -i eth0')).toBe(NO_CAPTURE);
    expect(await pc.executeCommand('tcpdump -w /tmp/x.pcap -c 1')).toBe(NO_CAPTURE);
    expect(await pc.executeCommand('ls /tmp/x.pcap')).toContain('No such file or directory');
  });

  it('under sudo the same capture runs', async () => {
    const { pc } = await lab();
    const pending = pc.executeCommand('sudo tcpdump -c 1 -nn -i eth0 icmp');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc.executeCommand('ping -c 1 10.0.0.2');
    expect(await pending).toMatch(/IP 10\.0\.0\.1 > 10\.0\.0\.2: ICMP echo request/);
  });

  it('witness: -D and reading a capture file need no packet socket', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('tcpdump -D')).toMatch(/^1\.eth0 \[Up, Running, Connected\]/);
    const pending = pc.executeCommand('sudo tcpdump -c 1 -nn -i eth0 -w /tmp/one.pcap icmp');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc.executeCommand('ping -c 1 10.0.0.2');
    await pending;
    expect(await pc.executeCommand('tcpdump -nn -r /tmp/one.pcap')).toMatch(/IP 10\.0\.0\.1 > 10\.0\.0\.2: ICMP echo request/);
  });
});

describe('traceroute — raw methods need CAP_NET_RAW, UDP and ICMP do not', () => {
  it('-T and -P fail before the header, as error_or_perm prints it', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('traceroute -n -q 1 -T 10.0.0.2')).toBe(NO_RAW_TRACE);
    expect(await pc.executeCommand('traceroute -n -q 1 -P 253 10.0.0.2')).toBe(NO_RAW_TRACE);
    expect(await pc.executeCommand('traceroute -n -q 1 -M tcp 10.0.0.2')).toBe(NO_RAW_TRACE);
    expect((await pc.executeCommand('sudo traceroute -n -q 1 -T 10.0.0.2')).split('\n')[1])
      .toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/);
  });

  it('witness: the default UDP method and -I stay open to user', async () => {
    const { pc } = await lab();
    for (const cmd of ['traceroute -n -q 1 10.0.0.2', 'traceroute -n -q 1 -I 10.0.0.2']) {
      expect((await pc.executeCommand(cmd)).split('\n')[1]).toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/);
    }
  });
});

describe('nmap — isr00t decides the scan, the discovery and what is refused', () => {
  it('user gets a connect() scan: conn-refused, no ARP, no MAC line', async () => {
    const { pc } = await lab();
    const out = await pc.executeCommand('nmap --reason -p 22,80 10.0.0.2');
    expect(out).toContain('Host is up, received conn-refused (');
    expect(out).toContain('22/tcp open   ssh     syn-ack');
    expect(out).toContain('80/tcp closed http    conn-refused');
    expect(out).not.toContain('MAC Address');
    const wide = await pc.executeCommand('nmap 10.0.0.2');
    expect(wide).toMatch(/Not shown: \d+ closed tcp ports \(conn-refused\)/);
  });

  it('root gets the SYN scan by default: reset, arp-response and the MAC line', async () => {
    const { srv } = await lab();
    const out = await srv.executeCommand('nmap --reason -p 22,80 10.0.0.1');
    expect(out).toContain('Host is up, received arp-response (');
    expect(out).toContain('80/tcp closed http    reset');
    expect(out).toContain('MAC Address: ');
    const connect = await srv.executeCommand('nmap -sT --ttl 5 -p 22 10.0.0.1');
    expect(connect).toContain('Starting Nmap 7.94 ( https://nmap.org )\n'
      + 'You have specified some options that require raw socket access.\n'
      + 'These options will not be honored for TCP Connect scan.');
  });

  it('the raw scan types, -O, -D and -PU are fatal for user, before the banner', async () => {
    const { pc } = await lab();
    const cases: Array<[string, string]> = [
      ['nmap -sS -p 22 10.0.0.2', 'You requested a scan type which requires root privileges.'],
      ['nmap -sU -p 53 10.0.0.2', 'You requested a scan type which requires root privileges.'],
      ['nmap -O 10.0.0.2', 'TCP/IP fingerprinting (for OS scan) requires root privileges.'],
      ['nmap -D 10.0.0.9 -p 22 10.0.0.2', 'Sorry, but decoys (-D) require root privileges.'],
      ['nmap -PU 10.0.0.2', 'Sorry, UDP Ping (-PU) only works if you are root (because we need to read raw responses off the wire)'],
    ];
    for (const [cmd, fatal] of cases) expect(await pc.executeCommand(cmd)).toBe(`${fatal}\nQUITTING!`);
  });

  it('--traceroute is refused after the banner; -A quietly drops -O and --traceroute', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nmap --traceroute -p 22 10.0.0.2'))
      .toBe('Starting Nmap 7.94 ( https://nmap.org )\nTraceroute has to be run as root\nQUITTING!');
    const advanced = await pc.executeCommand('nmap -A -p 22 10.0.0.2');
    expect(advanced).toContain('22/tcp open  ssh     OpenSSH_8.9p1 (protocol 2.0)');
    expect(advanced).not.toContain('OS details');
    expect(advanced).not.toContain('TRACEROUTE');
  });

  it('-PE falls back to a TCP pingscan with nmap\'s warning; raw options are not honored', async () => {
    const { pc } = await lab();
    expect((await pc.executeCommand('nmap -PE -p 22 10.0.0.2')).split('\n').slice(0, 2)).toEqual([
      'Warning:  You are not root -- using TCP pingscan rather than ICMP',
      'Starting Nmap 7.94 ( https://nmap.org )',
    ]);
    expect((await pc.executeCommand('nmap --ttl 5 -p 22 10.0.0.2')).split('\n').slice(0, 3)).toEqual([
      'Starting Nmap 7.94 ( https://nmap.org )',
      'You have specified some options that require raw socket access.',
      'These options will not be honored without the necessary privileges.',
    ]);
  });

  it('--privileged and --unprivileged override the uid, as NMAP_PRIVILEGED does', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nmap --privileged -p 22 10.0.0.2')).toContain('MAC Address: ');
    expect(await pc.executeCommand('sudo nmap --unprivileged -sS -p 22 10.0.0.2'))
      .toBe('You requested a scan type which requires root privileges.\nQUITTING!');
  });
});

describe('hping3 — IPPROTO_RAW needs CAP_NET_RAW', () => {
  it('user reaches open_sockraw and stops there; -V prints the interface first', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('hping3 -S -c 1 -p 22 10.0.0.2'))
      .toBe("[open_sockraw] socket(): Operation not permitted\n[main] can't open raw socket");
    expect(await pc.executeCommand('hping3 -V -S -c 1 -p 22 10.0.0.2'))
      .toBe("using eth0, addr: 10.0.0.1, MTU: 1500\n[open_sockraw] socket(): Operation not permitted\n[main] can't open raw socket");
  });

  it('witness: root sends and reads the reply', async () => {
    const { srv } = await lab();
    expect(await srv.executeCommand('hping3 -S -c 1 -p 22 10.0.0.1')).toContain('flags=SA');
  });
});

describe('the terminal — sudo streams the capture as root after the password', () => {
  function key(k: string, ctrlKey = false): KeyEvent {
    return { key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

  it('tcpdump typed by user is refused; sudo tcpdump asks the password, then streams', async () => {
    const { pc } = await lab();
    pc.powerOn();
    const session = new LinuxTerminalSession('t', pc);
    session.setInput('tcpdump -nn icmp');
    session.handleKey(key('Enter'));
    await settle();
    expect(session.lines.map((l) => l.text)).toContain('(socket: Operation not permitted)');

    session.setInput('sudo tcpdump -nn -c 1 icmp');
    session.handleKey(key('Enter'));
    await settle();
    expect(session.inputMode).toEqual({ type: 'password', promptText: '[sudo] password for user:' });
    session.setPasswordBuf('admin');
    session.handleKey(key('Enter'));
    await settle();
    await pc.executeCommand('ping -c 1 10.0.0.2');
    await settle();
    const text = session.lines.map((l) => l.text).join('\n');
    expect(text).toMatch(/IP 10\.0\.0\.1 > 10\.0\.0\.2: ICMP echo request/);
    expect(text).toContain('1 packet captured');
    expect(await pc.executeCommand('sudo cat /var/log/auth.log')).toMatch(/sudo: +user : .*COMMAND=.*tcpdump -nn -c 1 icmp/);
  });

  it('sudo traceroute -T streams its hops; the same line without sudo is refused', async () => {
    const { pc } = await lab();
    pc.powerOn();
    const session = new LinuxTerminalSession('t', pc);
    session.setInput('traceroute -n -q 1 -T 10.0.0.2');
    session.handleKey(key('Enter'));
    await settle();
    expect(session.lines.map((l) => l.text)).toContain('socket: Operation not permitted');
    session.setInput('sudo traceroute -n -q 1 -T 10.0.0.2');
    session.handleKey(key('Enter'));
    await settle();
    session.setPasswordBuf('admin');
    session.handleKey(key('Enter'));
    await settle();
    expect(session.lines.map((l) => l.text).some((l) => /^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/.test(l))).toBe(true);
  });
});

/*
 * traceroute (Butskoy 2.1.0, the one Ubuntu ships) and Windows tracert on
 * the user's lab, imported as exported and configured through each
 * device's CLI — the same lab and helpers as user-lab-hping3.test.ts.
 *
 * LAN 192.168.1.0/24 (PC1) — FW1 port1 192.168.1.99 / port2 192.168.20.2
 * (policy LAN -> HQ with NAT) — R3 192.168.20.1 / 192.168.30.1 — HQ
 * 192.168.30.0/24: Server1 .4, WinServer1 .2, PC3 .3. Nothing allows
 * HQ -> LAN, so a trace from WinServer1 towards PC1 dies at FW1.
 *
 * Every expectation below was MEASURED on this lab before being written.
 * What only a routed, NAT'd, firewalled path shows:
 *  - each probe METHOD really leaves as what it claims (UDP 33434+, ICMP
 *    echo, TCP SYN, raw protocol 253) and each is answered hop by hop;
 *    `-P 253` ends on Server1's protocol-unreachable, printed `!P`;
 *  - `-t`, `-F` and `--sport` reach the wire: tos 0x10, DF, sport 4444 on
 *    PC1's own capture, and the sport survives FW1's NAT on Server1's;
 *  - the three hops answer differently, and tcpdump shows it: FW1 and R3
 *    quote 8 bytes of the probe, Server1 — a Linux — quotes the whole
 *    60-byte datagram under tos 0xc0 without DF (net/ipv4/icmp.c);
 *  - WinServer1's tracert towards the LAN gets R3 then FW1, then silence,
 *    and towards an unrouted network stops on R3's
 *    `reports: Destination net unreachable.`.
 *
 * DISCRIMINATION (git stash of src/network, src/terminal and src/bash):
 * 9 of the 12 cases fall before the change. The three that pass on both
 * trees are witnesses that the lab itself answers: the default trace's
 * three hops, WinServer1's single-hop trace to Server1, and Server1's
 * capture telling the Windows echo (ttl 128) from the Linux reply.
 */
import { describe, it, expect } from 'vitest';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';

const SERVER1 = '192.168.30.4';
const WINSERVER1 = '192.168.30.2';
const PC1 = '192.168.1.10';

async function configuredLab(): Promise<UserLab> {
  const lab = await loadUserLab();
  await addRoutesToHq(lab);
  await taper(lab.PC1, [
    'ip addr add 192.168.1.10/24 dev eth0',
    'ip route add default via 192.168.1.99',
  ]);
  await taper(lab.Server1, ['systemctl start nginx', 'systemctl start ssh']);
  return lab;
}

async function captureWhile(
  capturer: UserLab[keyof UserLab], tcpdump: string, traffic: () => Promise<unknown>,
): Promise<string> {
  const pending = capturer.executeCommand(tcpdump);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await traffic();
  return String(await pending);
}

function hops(out: string): string[] {
  return out.split('\n').slice(1);
}

describe('user lab — Linux traceroute crosses FW1 and R3 with the probe it announces', () => {
  it('the default UDP method names FW1, R3 and Server1, each shown as its address when no name exists', async () => {
    const lab = await configuredLab();
    const out = await lab.PC1.executeCommand(`traceroute ${SERVER1}`);
    expect(out.split('\n')[0]).toBe('traceroute to 192.168.30.4 (192.168.30.4), 30 hops max, 60 byte packets');
    const lines = hops(out);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^ 1  192\.168\.1\.99 \(192\.168\.1\.99\)  \d+\.\d{3} ms  \d+\.\d{3} ms  \d+\.\d{3} ms$/);
    expect(lines[1]).toMatch(/^ 2  192\.168\.20\.1 \(192\.168\.20\.1\)  /);
    expect(lines[2]).toMatch(/^ 3  192\.168\.30\.4 \(192\.168\.30\.4\)  \d+\.\d{3} ms  \d+\.\d{3} ms  \d+\.\d{3} ms$/);
  });

  it('ICMP, TCP SYN and fixed-port UDP each reach WinServer1 or Server1 in three hops', async () => {
    const lab = await configuredLab();
    for (const cmd of [
      `traceroute -n -I ${WINSERVER1}`, `traceroute -n -T -p 22 ${SERVER1}`, `traceroute -n -U ${SERVER1}`,
    ]) {
      const lines = hops(await lab.PC1.executeCommand(cmd));
      expect(lines.map((l) => l.split(/\s+/)[2])).toEqual(['192.168.1.99', '192.168.20.1', expect.stringMatching(/^192\.168\.30\.[24]$/)]);
    }
  });

  it('a raw protocol-253 probe ends on Server1\'s protocol-unreachable, printed !P', async () => {
    const lab = await configuredLab();
    const lines = hops(await lab.PC1.executeCommand(`traceroute -n -P 253 -q 1 ${SERVER1}`));
    expect(lines[2]).toMatch(/^ 3  192\.168\.30\.4  \d+\.\d{3} ms !P$/);
  });

  it('-t, -F and --sport are on the wire; without -F the probe carries no DF', async () => {
    const lab = await configuredLab();
    const shaped = await captureWhile(lab.PC1, 'tcpdump -c 1 -n -v -i eth0 udp',
      () => lab.PC1.executeCommand(`traceroute -n -q 1 -m 1 -F -t 16 --sport=4444 ${SERVER1}`));
    expect(shaped).toMatch(/IP \(tos 0x10, ttl 1, id \d+, offset 0, flags \[DF\], proto UDP \(17\), length 60\)\n    192\.168\.1\.10\.4444 > 192\.168\.30\.4\.33434: UDP/);
    const plain = await captureWhile(lab.PC1, 'tcpdump -c 1 -n -v -i eth0 udp',
      () => lab.PC1.executeCommand(`traceroute -n -q 1 -m 1 ${SERVER1}`));
    expect(plain).toMatch(/IP \(tos 0x0, ttl 1, id \d+, offset 0, flags \[none\], proto UDP \(17\), length 60\)/);
  });

  it('Server1 receives the probe NAT\'d to FW1\'s address, source port and tos intact', async () => {
    const lab = await configuredLab();
    const seen = await captureWhile(lab.Server1, 'tcpdump -c 1 -n -v -i eth0 udp',
      () => lab.PC1.executeCommand(`traceroute -n -q 1 -f 3 -m 3 --sport=4444 -t 16 ${SERVER1}`));
    expect(seen).toMatch(/IP \(tos 0x10, ttl 1, .*proto UDP \(17\), length 60\)\n    192\.168\.20\.2\.4444 > 192\.168\.30\.4\.33434: UDP/);
  });

  it('each hop answers in its own way: routers quote 8 bytes, Linux quotes the whole datagram under tos 0xc0', async () => {
    const lab = await configuredLab();
    const out = await captureWhile(lab.PC1, 'tcpdump -c 3 -n -v -i eth0 icmp',
      () => lab.PC1.executeCommand(`traceroute -n -q 1 -m 3 ${SERVER1}`));
    expect(out).toMatch(/length 56\)\n    192\.168\.1\.99 > 192\.168\.1\.10: ICMP time exceeded in-transit, length 36\n\tIP \(tos 0x0, ttl 1, id \d+, offset 0, flags \[none\], proto UDP \(17\), length 60\)/);
    expect(out).toMatch(/ttl 254, .*length 56\)\n    192\.168\.20\.1 > 192\.168\.1\.10: ICMP time exceeded in-transit, length 36/);
    expect(out).toMatch(/IP \(tos 0xc0, ttl 62, id \d+, offset 0, flags \[none\], proto ICMP \(1\), length 88\)\n    192\.168\.30\.4 > 192\.168\.1\.10: ICMP 192\.168\.30\.4 udp port 33436 unreachable, length 68/);
  });

  it('socket options fail where Butskoy fails them: before the header for ICMP, after it for UDP', async () => {
    const lab = await configuredLab();
    const header = 'traceroute to 192.168.30.4 (192.168.30.4), 30 hops max, 60 byte packets';
    expect(await lab.PC1.executeCommand(`traceroute -n -i eth9 ${SERVER1}`))
      .toBe(`${header}\nsetsockopt SO_BINDTODEVICE: No such device`);
    expect(await lab.PC1.executeCommand(`traceroute -n -s 10.9.9.9 ${SERVER1}`))
      .toBe(`${header}\nbind: Cannot assign requested address`);
    expect(await lab.PC1.executeCommand(`traceroute -n -r ${SERVER1}`))
      .toBe(`${header}\nconnect: Network is unreachable`);
    expect(await lab.PC1.executeCommand(`traceroute -I -n -r ${SERVER1}`))
      .toBe('\nconnect: Network is unreachable');
  });

  it('-i and -s accept what the machine really has', async () => {
    const lab = await configuredLab();
    for (const cmd of [`traceroute -n -q 1 -i eth0 ${SERVER1}`, `traceroute -n -q 1 -s ${PC1} ${SERVER1}`]) {
      expect(hops(await lab.PC1.executeCommand(cmd))[2]).toMatch(/^ 3  192\.168\.30\.4  /);
    }
  });
});

describe('user lab — WinServer1 traces from the HQ side', () => {
  it('towards PC1, R3 and FW1 answer, then the deny from HQ leaves only timeouts', async () => {
    const lab = await configuredLab();
    const out = await lab.WinServer1.executeCommand(`tracert -d -h 4 ${PC1}`);
    const lines = out.split('\n');
    expect(lines[1]).toBe('Tracing route to 192.168.1.10 over a maximum of 4 hops');
    expect(lines[3]).toMatch(/^ {2}1 {3,5}(<1|\d+) ms {3,5}(<1|\d+) ms {3,5}(<1|\d+) ms {2}192\.168\.30\.1$/);
    expect(lines[4]).toMatch(/ {2}192\.168\.20\.2$/);
    expect(lines[5]).toBe('  3     *        *        *     Request timed out.');
    expect(lines[6]).toBe('  4     *        *        *     Request timed out.');
    expect(lines.slice(7)).toEqual(['', 'Trace complete.']);
  });

  it('towards an unrouted network, R3 reports it and tracert stops there', async () => {
    const lab = await configuredLab();
    const out = await lab.WinServer1.executeCommand('tracert -d -h 3 10.99.99.99');
    expect(out).toContain('  2  192.168.30.1  reports: Destination net unreachable.\n\nTrace complete.');
    expect(out).not.toContain('Request timed out.');
  });

  it('towards Server1 on its own segment, one hop', async () => {
    const lab = await configuredLab();
    const lines = (await lab.WinServer1.executeCommand(`tracert -d ${SERVER1}`)).split('\n');
    expect(lines[3]).toMatch(/ {2}192\.168\.30\.4$/);
    expect(lines.slice(4)).toEqual(['', 'Trace complete.']);
  });

  it('Server1\'s capture tells the Windows echo (ttl 128) from its Linux reply (ttl 64)', async () => {
    const lab = await configuredLab();
    const out = await captureWhile(lab.Server1, 'tcpdump -c 2 -nn -v -i eth0 icmp',
      () => lab.WinServer1.executeCommand(`ping -n 1 ${SERVER1}`));
    expect(out).toMatch(/IP \(tos 0x0, ttl 128, id \d+, offset 0, flags \[none\], proto ICMP \(1\), length 60\)\n    192\.168\.30\.2 > 192\.168\.30\.4: ICMP echo request, id \d+, seq 1, length 40/);
    expect(out).toMatch(/IP \(tos 0x0, ttl 64, id \d+, offset 0, flags \[none\], proto ICMP \(1\), length 60\)\n    192\.168\.30\.4 > 192\.168\.30\.2: ICMP echo reply, id \d+, seq 1, length 40/);
  });
});

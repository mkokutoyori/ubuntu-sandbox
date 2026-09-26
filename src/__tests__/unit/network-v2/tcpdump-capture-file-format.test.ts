/**
 * tcpdump -w / -r, read against tcpdump 4.99.1 and libpcap 1.10.1.
 *
 * The primitive renderer (`cmdTcpdump`) this file used to cross-check is
 * gone: nothing in production reached it. What is kept is the property it
 * was there for — a file written by `-w` reads back with `-r` — now asserted
 * on frames that really crossed the wire.
 *
 * Two defects closed alongside. `-r` on a missing file used to serialise the
 * host's TCP capture log and read THAT back, so a typo in the path printed
 * packets; libpcap opens the file and fails (`savefile.c`, `pcap_fmt_errmsg_
 * for_errno(..., "%s", fname)`), and tcpdump prints `tcpdump: <file>: No
 * such file or directory`. And `-r` with an unparsable filter printed every
 * packet; tcpdump compiles the filter after opening the file and stops on
 * `can't parse filter expression: syntax error` (`grammar.y.in` yyerror).
 *
 * Discrimination: the missing-file, unknown-format and bad-filter cases fall
 * before the change; the round trip passes on both trees (witness that the
 * lab produces and reads back real frames).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function linkedPair(): Promise<{ pc1: LinuxPC; pc2: LinuxPC }> {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
  await pc1.executeCommand('ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { pc1, pc2 };
}

describe('tcpdump capture files (tcpdump 4.99.1 / libpcap 1.10.1)', () => {
  it('a file written by -w reads back with -r, packet for packet', async () => {
    const { pc1 } = await linkedPair();
    const writing = pc1.executeCommand('tcpdump -w echo.cap -c 2 icmp');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc1.executeCommand('ping -c 1 10.0.0.2');
    await writing;

    const output = await pc1.executeCommand('tcpdump -nn -r echo.cap');
    expect(output).toContain('reading from file echo.cap, link-type EN10MB (Ethernet), snapshot length 262144');
    expect(output).toMatch(/IP 10\.0\.0\.1 > 10\.0\.0\.2: ICMP echo request/);
    expect(output).toMatch(/IP 10\.0\.0\.2 > 10\.0\.0\.1: ICMP echo reply/);
  });

  it('a missing file is an error even when the host has captured TCP traffic', async () => {
    const { pc1, pc2 } = await linkedPair();
    await pc2.executeCommand('nc -l -p 9000 &');
    await pc1.executeCommand('nc -z 10.0.0.2 9000');

    const output = await pc1.executeCommand('tcpdump -r missing.cap');
    expect(output).toBe('tcpdump: missing.cap: No such file or directory');
  });

  it('a file that is not a capture is refused in libpcap\'s own words', async () => {
    const pc1 = new LinuxPC('PC1', 0, 0);
    await pc1.executeCommand('echo "not a capture file" > garbage.cap');
    const output = await pc1.executeCommand('tcpdump -r garbage.cap');
    expect(output).toBe('tcpdump: unknown file format');
  });

  it('-r compiles the filter, and an unparsable one stops the read', async () => {
    const { pc1 } = await linkedPair();
    const writing = pc1.executeCommand('tcpdump -w echo.cap -c 2 icmp');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await pc1.executeCommand('ping -c 1 10.0.0.2');
    await writing;

    const output = await pc1.executeCommand('tcpdump -r echo.cap host');
    expect(output).toBe('tcpdump: can\'t parse filter expression: syntax error');
  });
});

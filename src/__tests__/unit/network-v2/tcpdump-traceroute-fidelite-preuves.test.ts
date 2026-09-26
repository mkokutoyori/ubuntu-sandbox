/*
 * tcpdump 4.99.1 / libpcap 1.10.1 and traceroute 2.1.0 on a direct link:
 * the command-line surface, read against the upstream sources.
 *
 * Measured before the change, each flag below was either accepted and
 * ignored (-F -Z -N -f -p --count --print -V -G -C -W --nano, and -L with
 * a later -i), refused as an unknown option, or answered in wording no
 * version of tcpdump prints (`tcpdump: error: ...`). The filter compiler
 * gave `net 10.0.0.0` a /24 mask where libpcap gives /32, refused `port
 * ssh`, capped byte offsets at 1500 and accepted `proto tcp` unescaped.
 *
 * Sources: tcpdump.c (option switch, read_infile, droproot, MakeFilename,
 * info), util-print.c (ts_print), addrtoname.c; libpcap gencode.c
 * (gen_ncode, gen_mcode, gen_port), grammar.y.in (yyerror), savefile.c;
 * traceroute/traceroute.c (main's checks, set_port, set_wait_specs) and
 * libsupp/clif.c (set_uint uses strtoul, so `-m 010` is octal 8).
 *
 * DISCRIMINATION (git stash of src/network, src/terminal and src/bash):
 * all 12 cases fall before the change.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

async function pair(): Promise<{ pc1: LinuxPC; pc2: LinuxPC }> {
  const pc1 = new LinuxPC('PC1', 0, 0);
  const pc2 = new LinuxPC('PC2', 100, 0);
  new Cable('c1').connect(pc1.getPort('eth0')!, pc2.getPort('eth0')!);
  await pc1.executeCommand('sudo ifconfig eth0 10.0.0.1 netmask 255.255.255.0');
  await pc2.executeCommand('sudo ifconfig eth0 10.0.0.2 netmask 255.255.255.0');
  return { pc1, pc2 };
}

async function captureWhile(capturer: LinuxPC, tcpdump: string, traffic: () => Promise<unknown>): Promise<string> {
  const pending = capturer.executeCommand(tcpdump);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await traffic();
  return pending;
}

function packets(out: string): string[] {
  return out.split('\n').filter((l) => /^ ?\S*\d\d:\d\d:\d\d\.\d+ /.test(l) || /^\d{10}\.\d+ /.test(l));
}

describe('tcpdump — the filter compiles the way libpcap compiles it', () => {
  it('a full dotted net is a /32, a short one is promoted by its octet count, stray host bits are refused', async () => {
    const { pc1, pc2 } = await pair();
    const exact = await captureWhile(pc1, 'tcpdump -c 1 -nn net 10.0.0.2', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(packets(exact)).toHaveLength(1);
    const promoted = await captureWhile(pc1, 'tcpdump -c 2 -nn icmp and net 10.0.0', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(packets(promoted)).toHaveLength(2);
    expect(await pc1.executeCommand('tcpdump net 10.0.0.1/24')).toBe('tcpdump: non-network bits set in "10.0.0.1/24"');
    expect(await pc1.executeCommand('tcpdump net 10.0.0.1 mask 255.255.255.0'))
      .toBe('tcpdump: non-network bits set in "10.0.0.1 mask 255.255.255.0"');
    void pc2;
  });

  it('service names, escaped protocol names and out-of-range offsets compile; bare keywords do not', async () => {
    const { pc1 } = await pair();
    for (const filter of ['port ssh', 'tcp portrange 22-ssh', 'proto \\\\tcp', "'ip proto \\tcp'", '"ip[9000] == 1"']) {
      expect(await pc1.executeCommand(`tcpdump ${filter}`)).toContain('listening on eth0');
    }
    expect(await pc1.executeCommand('tcpdump proto tcp')).toBe("tcpdump: can't parse filter expression: syntax error");
    expect(await pc1.executeCommand('tcpdump proto \\\\nosuch')).toBe("tcpdump: unknown ip proto 'nosuch'");
  });

  it('-F reads the expression from a file, comments stripped, and ignores the command line', async () => {
    const { pc1 } = await pair();
    await pc1.executeCommand("bash -c 'printf \"icmp # only echo traffic\\n\" > /tmp/f.bpf'");
    const out = await captureWhile(pc1, 'tcpdump -c 1 -nn -F /tmp/f.bpf tcp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(packets(out)[0]).toContain('ICMP echo request');
    expect(await pc1.executeCommand('tcpdump -F /tmp/none.bpf'))
      .toBe("tcpdump: can't open /tmp/none.bpf: No such file or directory");
  });
});

describe('tcpdump — every accepted flag does what it says', () => {
  it('--count prints only the counters, --print prints while writing', async () => {
    const { pc1 } = await pair();
    const counted = await captureWhile(pc1, 'tcpdump -c 2 -nn --count icmp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(packets(counted)).toHaveLength(0);
    expect(counted).toContain('2 packets captured');
    const printed = await captureWhile(pc1, 'tcpdump -c 2 -nn -w /tmp/p.cap --print icmp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(packets(printed)).toHaveLength(2);
    expect(await pc1.executeCommand('tcpdump -r /tmp/p.cap --count')).toMatch(/\n2 packets$/);
  });

  it('-V reads each file of a list, a reading line per file', async () => {
    const { pc1 } = await pair();
    await captureWhile(pc1, 'tcpdump -c 2 -w /tmp/a.cap icmp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    await pc1.executeCommand("bash -c 'printf \"/tmp/a.cap\\n/tmp/a.cap\\n\" > /tmp/list'");
    const out = await pc1.executeCommand('tcpdump -nn -V /tmp/list');
    expect(out.match(/^reading from file \/tmp\/a\.cap, link-type EN10MB \(Ethernet\), snapshot length 262144$/gm)).toHaveLength(2);
    expect(packets(out)).toHaveLength(4);
    expect(await pc1.executeCommand('tcpdump -V /tmp/list -r /tmp/a.cap')).toBe('tcpdump: -V and -r are mutually exclusive.');
  });

  it('-Z drops to the named user, who then owns the capture file', async () => {
    const { pc1 } = await pair();
    const out = await captureWhile(pc1, 'sudo tcpdump -c 1 -Z nobody -w /tmp/z.cap icmp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(out.split('\n')[0]).toBe('dropped privs to nobody');
    expect(await pc1.executeCommand('ls -l /tmp/z.cap')).toMatch(/^-\S+ 1 nobody /);
    expect(await pc1.executeCommand('sudo tcpdump -Z ghost')).toBe("tcpdump: Couldn't find user 'ghost'");
  });

  it('--nano prints nine fractional digits; -ttt prints the delta with its leading sign column', async () => {
    const { pc1 } = await pair();
    const nano = await captureWhile(pc1, 'tcpdump -c 1 -nn --nano icmp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(nano).toMatch(/^\d\d:\d\d:\d\d\.\d{9} IP 10\.0\.0\.1 > 10\.0\.0\.2/m);
    const delta = await captureWhile(pc1, 'tcpdump -c 1 -nn -ttt icmp', () => pc1.executeCommand('ping -c 1 10.0.0.2'));
    expect(delta).toMatch(/^ 00:00:00\.000000 IP 10\.0\.0\.1 > 10\.0\.0\.2/m);
  });

  it('options follow getopt_long: abbreviations, ambiguity, late -i for -L, and a refused brick is named', async () => {
    const { pc1 } = await pair();
    expect(await pc1.executeCommand('tcpdump --vers')).toMatch(/^tcpdump version 4\.99\.1\n/);
    expect(await pc1.executeCommand('tcpdump --p')).toMatch(/^tcpdump: option '--p' is ambiguous; possibilities: '--packet-buffered' '--print'\n/);
    expect(await pc1.executeCommand('tcpdump -L -i lo')).toBe('Data link types for lo (use option -y to set):\n  EN10MB (Ethernet)');
    expect(await pc1.executeCommand('tcpdump -h')).toMatch(/^tcpdump version 4\.99\.1\nlibpcap version 1\.10\.1 \(with TPACKET_V3\)\nOpenSSL 3\.0\.2 15 Mar 2022\nUsage: tcpdump /);
    expect(await pc1.executeCommand('tcpdump -T snmp')).toBe('tcpdump: -T snmp: this simulator has no snmp printer');
    expect(await pc1.executeCommand('tcpdump -T nosuch')).toBe("tcpdump: unknown packet type `nosuch'");
    expect(await pc1.executeCommand('tcpdump -m SNMPv2-MIB -c 1 -i lo'))
      .toMatch(/^tcpdump: ignoring option `-m SNMPv2-MIB' \(no libsmi support\)\n/);
  });
});

describe('the interactive terminal runs the same tcpdump', () => {
  function key(k: string, ctrlKey = false): KeyEvent {
    return { key: k, ctrlKey, altKey: false, metaKey: false, shiftKey: false };
  }

  it('-Q in on the terminal keeps only what arrives, as the scripted command does', async () => {
    const { pc1 } = await pair();
    pc1.powerOn();
    const session = new LinuxTerminalSession('t', pc1);
    session.setInput('tcpdump -nn -Q in icmp');
    session.handleKey(key('Enter'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await pc1.executeCommand('ping -c 1 10.0.0.2');
    await new Promise((resolve) => setTimeout(resolve, 20));
    session.handleKey(key('c', true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const lines = session.lines.map((l) => l.text);
    expect(lines.filter((l) => l.includes('ICMP echo request'))).toHaveLength(0);
    expect(lines.filter((l) => l.includes('10.0.0.2 > 10.0.0.1: ICMP echo reply'))).toHaveLength(1);
    expect(lines).toContain('1 packet captured');
  });
});

describe('traceroute — Butskoy\'s own parsing and probes on a direct link', () => {
  it('numbers parse as strtoul does: octal, wrapped negatives, and main()\'s checks', async () => {
    const { pc1 } = await pair();
    expect((await pc1.executeCommand('traceroute -n -m 010 10.0.0.2')).split('\n')[0])
      .toBe('traceroute to 10.0.0.2 (10.0.0.2), 8 hops max, 60 byte packets');
    expect(await pc1.executeCommand('traceroute -m -1 10.0.0.2')).toBe('max hops cannot be more than 255');
    expect(await pc1.executeCommand('traceroute -z -1 10.0.0.2')).toBe("bad sendtime `-1' specified");
    expect(await pc1.executeCommand('traceroute -M udplite 10.0.0.2'))
      .toBe('traceroute: module udplite: this simulator cannot build a UDPLITE datagram');
    expect(await pc1.executeCommand('traceroute -M nosuch 10.0.0.2')).toBe('Unknown traceroute module nosuch');
  });

  it('-p takes a service name and -r reaches an on-link host', async () => {
    const { pc1 } = await pair();
    const named = await pc1.executeCommand('traceroute -n -U -p domain -q 1 10.0.0.2');
    expect(named.split('\n')[1]).toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/);
    const direct = await pc1.executeCommand('traceroute -n -r -q 1 10.0.0.2');
    expect(direct.split('\n')[1]).toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms$/);
  });

  it('-P sends the raw protocol and ends on the target\'s protocol-unreachable', async () => {
    const { pc1, pc2 } = await pair();
    const out = await captureWhile(pc2, 'tcpdump -c 1 -nn -v ip proto 253', () => pc1.executeCommand('traceroute -n -P 253 -q 1 10.0.0.2'));
    expect(out).toMatch(/proto unknown \(253\), length 60\)/);
    expect((await pc1.executeCommand('traceroute -n -P 253 -q 1 10.0.0.2')).split('\n')[1])
      .toMatch(/^ 1 {2}10\.0\.0\.2 {2}\d+\.\d{3} ms !P$/);
  });
});

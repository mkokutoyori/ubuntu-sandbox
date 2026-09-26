/*
 * tcpdump 4.99.1 / libpcap 1.10.1 (the versions Ubuntu 22.04 ships and the
 * simulator announces) on the user's lab. Each expectation was MEASURED
 * here first; the upstream sources quoted are tcpdump-4.99.1 and
 * libpcap-1.10.1.
 *
 * What the lab shows that a direct link cannot:
 *  - Server1 sees PC1's HTTP connection from FW1's port2 address, the NAT
 *    that policy 1 applies; `-S` keeps the ISNs absolute, `-n` off names
 *    the service (`.http`, from /etc/services) while the addresses stay
 *    numeric, because nothing resolves them;
 *  - `-i any` switches to LINUX_SLL2 (Linux cooked v2) and prefixes each
 *    line with the interface and the packet type (`eth0  In `, `eth0  Out`,
 *    print-sll.c sll2_if_print);
 *  - `-e` without `-n` names what libpcap knows: `Broadcast`, and
 *    `(oui Unknown)` for a vendor absent from oui.c; the frame lengths are
 *    the CAPTURED ones — 42 for the request PC3 emits, 60 for the padded
 *    reply it receives — never the FCS-inclusive wire size;
 *  - `-w -C -W` names the ring file `ring.pcap0` (MakeFilename with a
 *    one-digit suffix), and `-r --count` counts it.
 *
 * DISCRIMINATION (git stash of src/network, src/terminal and src/bash):
 * all 7 cases fall before the change.
 */
import { describe, it, expect } from 'vitest';
import { addRoutesToHq, loadUserLab, type UserLab } from './userLab';
import { taper } from './fortigateBatteryHarness';

const SERVER1 = '192.168.30.4';
const WINSERVER1 = '192.168.30.2';

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

function packets(out: string): string[] {
  return out.split('\n').filter((l) => /^\d\d:\d\d:\d\d\.\d{6} /.test(l));
}

describe('user lab — tcpdump on the HQ side', () => {
  it('Server1 sees PC1\'s handshake from FW1\'s NAT address, ISNs absolute with -S', async () => {
    const lab = await configuredLab();
    const out = await captureWhile(lab.Server1, 'tcpdump -c 3 -nn -S -i eth0 tcp port 80',
      () => lab.PC1.executeCommand(`curl -s -o /dev/null http://${SERVER1}/`));
    const [syn, synAck, ack] = packets(out);
    expect(syn).toMatch(/IP 192\.168\.20\.2\.(\d+) > 192\.168\.30\.4\.80: Flags \[S\], seq (\d+), win \d+, options \[mss 1460,sackOK,TS val \d+ ecr 0,wscale 7\], length 0$/);
    const isn = Number(/seq (\d+)/.exec(syn)![1]);
    expect(synAck).toContain(`ack ${isn + 1}, win`);
    expect(ack).toMatch(/Flags \[\.\], ack \d+, win \d+/);
  });

  it('without -n the service is named from /etc/services and the unresolved address stays numeric', async () => {
    const lab = await configuredLab();
    const out = await captureWhile(lab.Server1, 'tcpdump -c 1 -i eth0 tcp port 80',
      () => lab.PC1.executeCommand(`curl -s -o /dev/null http://${SERVER1}/`));
    expect(packets(out)[0]).toMatch(/IP 192\.168\.20\.2\.\d+ > 192\.168\.30\.4\.http: Flags \[S\], seq \d+,/);
  });

  it('a filter names a service and an /etc/hosts entry the way libpcap resolves them', async () => {
    const lab = await configuredLab();
    await lab.Server1.executeCommand("bash -c 'echo \"192.168.30.2 winserver1\" >> /etc/hosts'");
    const out = await captureWhile(lab.Server1, 'tcpdump -c 1 -i eth0 icmp and host winserver1',
      () => lab.WinServer1.executeCommand(`ping -n 1 ${SERVER1}`));
    expect(packets(out)[0]).toMatch(/IP winserver1 > 192\.168\.30\.4: ICMP echo request, id \d+, seq 1, length 40$/);
    expect(await lab.Server1.executeCommand('tcpdump -i eth0 host nosuchhost'))
      .toBe("tcpdump: unknown host 'nosuchhost'");
  });

  it('-i any captures in Linux cooked v2, each line naming the interface and the direction', async () => {
    const lab = await configuredLab();
    const out = await captureWhile(lab.Server1, 'tcpdump -i any -c 2 -n icmp',
      () => lab.WinServer1.executeCommand(`ping -n 1 ${SERVER1}`));
    expect(out).toContain('listening on any, link-type LINUX_SLL2 (Linux cooked v2), snapshot length 262144 bytes');
    const [request, reply] = packets(out);
    expect(request).toMatch(/ eth0 {2}In {2}IP 192\.168\.30\.2 > 192\.168\.30\.4: ICMP echo request/);
    expect(reply).toMatch(/ eth0 {2}Out IP 192\.168\.30\.4 > 192\.168\.30\.2: ICMP echo reply/);
  });

  it('-e names Broadcast and the unknown OUI, and prints captured lengths, not wire lengths', async () => {
    const lab = await configuredLab();
    await lab.PC3.executeCommand('ip neigh flush all');
    const out = await captureWhile(lab.PC3, 'tcpdump -e -c 2 arp',
      () => lab.PC3.executeCommand(`ping -c 1 ${WINSERVER1}`));
    const [request, reply] = packets(out);
    expect(request).toMatch(/ ([0-9a-f:]{17}) \(oui Unknown\) > Broadcast, ethertype ARP \(0x0806\), length 42: ARP, Request who-has 192\.168\.30\.2 tell 192\.168\.30\.3, length 28$/);
    expect(reply).toMatch(/ \(oui Unknown\) > [0-9a-f:]{17} \(oui Unknown\), ethertype ARP \(0x0806\), length 60: ARP, Reply 192\.168\.30\.2 is-at [0-9a-f:]{17} \(oui Unknown\), length 46$/);
  });

  it('-w -C -W writes a numbered ring file that -r --count reads back', async () => {
    const lab = await configuredLab();
    const out = await captureWhile(lab.Server1, 'tcpdump -i eth0 -w /tmp/ring.pcap -C 1 -W 3 -c 2 icmp',
      () => lab.WinServer1.executeCommand(`ping -n 1 ${SERVER1}`));
    expect(out).toBe('tcpdump: listening on eth0, link-type EN10MB (Ethernet), snapshot length 262144 bytes\n'
      + '2 packets captured\n2 packets received by filter\n0 packets dropped by kernel');
    expect(await lab.Server1.executeCommand('ls /tmp/ring.pcap0')).toBe('/tmp/ring.pcap0');
    expect(await lab.Server1.executeCommand('tcpdump -r /tmp/ring.pcap0 --count'))
      .toBe('reading from file /tmp/ring.pcap0, link-type EN10MB (Ethernet), snapshot length 262144\n2 packets');
  });

  it('-D orders the interfaces the way libpcap ranks them', async () => {
    const lab = await configuredLab();
    expect(await lab.Server1.executeCommand('tcpdump -D')).toBe([
      '1.eth0 [Up, Running, Connected]',
      '2.any (Pseudo-device that captures on all interfaces) [Up, Running]',
      '3.lo [Up, Running, Loopback]',
      '4.eth1 [Up, Disconnected]',
      '5.eth2 [Up, Disconnected]',
      '6.eth3 [Up, Disconnected]',
    ].join('\n'));
  });
});

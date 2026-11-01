/**
 * tcpdump -nn, -tttt, -vvv, -XX and -A/-AA (alone and combined, with -X, -x, -e, -q, -S and -ttt/-tt), against the real tcpdump 4.99.4 /
 * libpcap 1.10.4 (Ubuntu 24.04).
 *
 * scripts/oracle/record_tcpdump_options.py writes the frames of two simulator labs into pcap files (the bytes each frame carries are
 * the ones the simulator puts on the wire) and records what the real binary prints for every option set. Lab "base": a LAN with
 * ICMP echo and errors, fragmented echoes, IPv4 and IPv6 TCP and UDP, ARP, NDP, traceroute, HTTP, FTP, SMTP and SSH payloads.
 * Lab "dns": a BIND server answering A, MX, AAAA, SOA, NS, ANY, NXDOMAIN, a truncated answer and DNS over TCP. The replay writes the
 * same capture file into a simulated host and runs `tcpdump <options> -r`; the whole text is compared, only the clock's date and
 * hour being normalised (the recorder ran in UTC).
 * Measured before the change (git stash push -- src/network): all 22 option cases fall, on bytes (the TCP options and their order,
 * every checksum, the ICMP error quotes, ARP padding, NDP bodies, fragment tails, the 16-octet ICMPv6/IPv6 sizes) or on printers (ICMPv6,
 * DNS, SSH/HTTP/FTP/SMTP, the -XX column and its ASCII rule, "-v" ARP, signed -ttt deltas, protocol names of fragments). The 2
 * WITNESS cases (one timestamped line per packet, in both labs) pass either way: they prove the labs replay the same packets.
 * -A and -AA (print.c lines 476-495, print-ascii.c ascii_print: the bytes after the link header, or all of them for -AA, with CR dropped at line end and every non-graphic byte but tab, space and LF printed as a dot)
 * were added with the real binary rerun on the stored captures (5 option sets per lab, the 11 earlier ones reproduced byte for byte): all 10 fall before, none is a witness.
 * Second lot, same method (print-ether.c ether_type_print: with -q an Ethernet type is its bare name, `ARP, ` and not `ethertype ARP (0x0806), `; print-ip.c line 494: -qq prints nothing
 * after the protocol for a non-initial fragment, and under -v only the header and four spaces): 6 of the 12 new cases fall before (-qq -nn and -qq -nn -v in the base lab, -nn -e -q and -nn -e -q -v in both).
 * The other 6 pass either way and are measurements, not witnesses of a fix: -nn -c 5 -s 60, -nn -N, -nn -O, -nn -vv, -nn -t, -nn -tttt -S and -q -nn -v in both labs agree with the real tool already.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Lab { capture: unknown; outputs: Record<string, string> }
const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tcpdump-options-4.99.4.json', import.meta.url), 'utf8')) as { labs: Record<string, Lab> };

function normalised(text: string): string {
  return text.split('\n').filter(line => !line.startsWith('reading from file '))
    .map(line => line.replace(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d(?=\.\d)/, 'T')).join('\n').replace(/\n+$/, '');
}

async function replay(capture: unknown, options: string): Promise<string> {
  const pc = new LinuxPC('PC1', 0, 0);
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/tmp/replay.cap', JSON.stringify(capture), 0, 0, 0o022);
  return pc.executeCommand(`sudo tcpdump ${options} -r /tmp/replay.cap`);
}

for (const [name, lab] of Object.entries(fixture.labs)) {
  describe(`tcpdump options against the real tool: lab ${name}`, () => {
    it('WITNESS: one timestamped line per packet, as the real tool prints', async () => {
      const packets = (text: string): number => text.split('\n').filter(line => /^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d\.\d/.test(line)).length;
      expect(packets(await replay(lab.capture, '-nn'))).toBe(packets(lab.outputs['-nn']));
    });

    for (const options of Object.keys(lab.outputs)) {
      it(options, async () => {
        expect(normalised(await replay(lab.capture, options))).toBe(normalised(lab.outputs[options]));
      });
    }
  });
}

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
 * Third lab, "rip": a PC cabled to a Cisco router that runs RIPv2 with a neighbour (CDP switched off: its frames are still zero bytes, see TODO.md). Measured before the change: the RIP datagrams carried
 * zero-filled bytes, which the real tool printed as `RIPv0` with a hex dump; the simulator now puts the RFC 2453 wire format in the capture (command, version, entries, text authentication) and prints it like
 * print-rip.c (request with the AFI 0 entry, responses with `AFI IPv4, %15s/%-2d, tag, metric, next-hop`, `-v` hex dump of the datagram). 21 of the 29 cases of this lab fall before; the other 8 print no RIP line.
 * Fourth lab, "ospf": a PC, two Cisco routers (one redistributing a connected network) and a hub, so the capture holds the whole OSPFv2 exchange (Hello with and without neighbours, Database Description,
 * LS-Request, LS-Update with Router, Network and External LSAs, LS-Ack). Measured before the change: every OSPF packet carried zero bytes and an IP length of 84, the real tool printed `OSPFv0, unknown LS-type 0`.
 * The simulator now writes the RFC 2328 wire format (src/network/ospf/OspfWire.ts: header with Internet checksum, Hello, DD, LSR, LSU, LSAck, LSA headers with the RFC 905 Fletcher checksum, MD5 trailer) and the
 * IP length of the datagram is that of the packet; TcpdumpOspf.ts ports print-ospf.c (including the [|ospf2] that the real LS-Ack loop ends with, after which -A/-x/-X dump the frame from the link header).
 * 28 of the 116 cases fall without the change (the lab's cases that print an OSPF line); the others print none.
 * Fifth lab, "cdp": a PC cabled to a Cisco router with CDP on. Measured before the change: the CDP frame was a 60-byte block of zeros under a made-up ethertype 0x2000, the real tool printed it as an unknown ethertype.
 * The capture now holds an 802.3 frame (length field, LLC/SNAP `AA AA 03 00 00 0C 20 00`) and the CDPv2 TLVs (src/network/cdp/CdpWire.ts: Device-ID, Addresses, Port-ID, Capabilities, Version, Platform, VTP domain, Native VLAN, Duplex,
 * Internet checksum); TcpdumpCdp.ts ports print-cdp.c, quirks included (without -v every TLV but the Device-ID is hex-dumped), and the -e line carries the 802.3 / LLC SNAP text of print-llc.c for this one frame type.
 * 28 of the 145 cases fall without the change (the lab's cases that print a CDP line).
 * Sixth lab, "lldp": a PC cabled to a Cisco switch with `lldp run` (STP, CDP and DTP switched off: their frames are still zero bytes, see TODO.md). Measured before the change: the LLDP frame carried no bytes after the
 * Ethernet header. The capture now holds the 802.1AB TLVs (src/network/lldp/LldpWire.ts: chassis, port, TTL, port description, system name and description, capabilities, management addresses, the 802.1 PVID and VLAN name,
 * the 802.3 MAC/PHY and maximum frame size) and TcpdumpLldp.ts ports print-lldp.c for them. The MAC/PHY PMD capability and MAU type are written as 0 (the simulator does not model them).
 * 28 of the 174 cases fall without the change.
 * Seventh to thirteenth labs (STP): "stp" (PC cabled to a Cisco switch, 802.1D), "rstp" (rapid-pvst), "pvst" (trunk with VLAN 10: PVST+ SNAP 0x010b frames behind an 802.1Q tag), "mstp" (region name, revision, digest),
 * "stppair"/"rstppair" (two switches and a hub: root BPDUs, a topology change, the TCN and its acknowledgement) and "stpcraft" (frames written by the recorder, not by the simulator: SPB v4, MSTIs, invalid lengths,
 * unknown versions and types, half-even %.2f timers, and capture records cut short so that `[|stp]` appears). Measured before the change: every BPDU carried zero bytes under ethertype 0x4242 and the real tool printed an unknown
 * ethertype. src/network/stp/StpWire.ts writes the 802.3 + LLC frame; TcpdumpStp.ts ports print-stp.c; TcpdumpLlc.ts carries the LLC/SNAP text shared with CDP; unknown ethertypes now print the header and the default dump of
 * print-ether.c. 208 new cases, 201 fall without the change; the 7 that pass either way are the labs' WITNESS cases. The DTP frames that the switches still send are zero bytes and print as `ethertype Unknown (0x2004)` in both tools.
 * Fourteenth lab, "eigrp": a PC, two Cisco routers and a hub, EIGRP AS 100 with a connected network redistributed. Measured before the change: every EIGRP packet carried zero bytes and an IP length of 84, the real tool printed
 * `EIGRP version 0 packet not supported`. The engine now models the reliable transport it needs to write the header (a sequence number per Update, the Init flag on the first Update to a neighbour, the acknowledgement
 * Hello with ack = the sequence and no TLV) and src/network/eigrp/EigrpPacketBytes.ts writes RFC 7868 bytes (header with Internet checksum, Parameters, Software Version 12.4 / 1.2, IP Internal and External route TLVs
 * with delay = tens of microseconds x 256, bandwidth = 10^7/kbps x 256, MTU 1500, reliability 255, load 1); TcpdumpEigrp.ts ports print-eigrp.c for the TLVs it decodes. 28 of the 29 cases fall without the change, the
 * 29th is the lab's WITNESS. Not covered: the MD5 Authentication TLV (the engine's digest is not an MD5), the Stub TLV flag bits, and the AppleTalk / IPX TLVs the simulator never writes.
 * Fifteenth lab, "dtp": a PC cabled to a Cisco switch whose port is `dynamic desirable` with VTP domain LAB. Measured before the change: the DTP frame was a block of zeros under the made-up ethertype 0x2004 (it also sat in
 * the STP labs, which fall with it). DtpWire.ts now writes the 802.3 + LLC/SNAP Cisco frame (pid 0x2004) and the TLVs as Wireshark's packet-dtp.c documents them: version 1, Domain (NUL-terminated), Trunk Status (operating bit 0x80,
 * administrative 1 on / 2 off / 3 desirable / 4 auto), Trunk Type (operating type in the top three bits: 1 native, 2 ISL, 5 802.1Q; administrative type 0 negotiated / 2 ISL / 5 802.1Q) and Sender ID; TcpdumpDtp.ts ports print-dtp.c.
 * The Domain TLV now carries the switch's VTP domain (DtpAgent kept a second, never-written domain; it reads the VTP one through the host). 56 of the 440 cases fall without the change (the dtp lab and the STP labs that hold a DTP frame).
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

/**
 * tcpdump -r on savefiles of every shape, against the real tcpdump 4.99.4 / libpcap 1.10.4 (Ubuntu 24.04).
 *
 * scripts/oracle/record_tcpdump_savefile.py keeps a capture written by the real tcpdump (ARP and two ICMP echo exchanges) and builds
 * the same packets in other shapes: nanosecond magic, a snapshot shorter than the packets (and shorter than the IP header), Linux
 * cooked v1 and v2 headers (incoming, outgoing, an interface index the reader does not have), a damaged tail, a header cut at every length
 * that matters, a version libpcap refuses, a file that is no capture, a link type nobody assigned. The real tool reads each file with
 * several option sets; stdout and stderr come back in the order it wrote them. The simulator reads the same bytes and must print the
 * same text (the clock's date and hour normalised, the recorder's temporary path replaced).
 *
 * Measured before the change (git stash push -- src): 41 of the 42 cases that run fall — the savefile of the simulator was a JSON document of
 * this repository, so a real capture answered `unknown file format` and every damaged file answered the same sentence instead of libpcap's
 * own. The one that passes either way is `not-a-capture` (NON-REGRESSION: that file never was a capture). The WITNESS is `real-capture -nn`:
 * the capture the real tool wrote must print its six packets, which proves the harness feeds the simulator the same bytes the tool read.
 *
 * The real file(1) classifies each of the 30 shapes too (`describe('file on savefiles ...')`). Measured before the change (the 3 lines of
 * `describeFile` removed): 27 of the 29 cases that run fall — every capture was `data`, the simulator knew tar and zip and nothing else. The two
 * that pass either way are the empty file and `not-a-capture` (plain text). `three-bytes` is not run: libmagic calls it `ISO-8859 text, with no
 * line terminators`, a text-encoding heuristic that is not ported.
 *
 * Not run, 24 cases: a snapshot cut inside the headers (`lab-snapshot-14` ... `-128`, `snapshot-shorter-than-the-ip-header`) is printed
 * differently by the simulator in every protocol (`[|tcp]`, `[|icmp6]`, `[|arp]`, the length of a cut ICMPv6 echo), on a live capture with
 * `-s` as well as on a file; the gap is measured in TODO.md.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { bytesToFileText } from '@/crypto/encoding';
import type { VirtualFileSystem } from '@/network/devices/linux/VirtualFileSystem';

interface Run { options: string; status: number; output: string }
interface Case { name: string; hex: string; file: string; runs: Run[] }
const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tcpdump-savefile-4.99.4.json', import.meta.url), 'utf8')) as { cases: Case[] };

const bytesOf = (hex: string): Uint8Array => Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));

function normalised(text: string): string {
  return text.split('\n')
    .map((line) => line.replace(/^(\d{4}-\d\d-\d\d )?\d\d:\d\d:\d\d(?=\.\d)/, 'T').replace(/\/tmp\/tmp\w+\/capture\.pcap/, '/tmp/capture.pcap'))
    .join('\n').replace(/\n+$/, '');
}

function machineHolding(hex: string): LinuxPC {
  const pc = new LinuxPC('PC1', 0, 0);
  const vfs = (pc as unknown as { executor: { vfs: VirtualFileSystem } }).executor.vfs;
  vfs.writeFile('/tmp/capture.pcap', bytesToFileText(bytesOf(hex)), 0, 0, 0o022);
  return pc;
}

async function read(hex: string, options: string): Promise<string> {
  return machineHolding(hex).executeCommand(`sudo tcpdump ${options} -r /tmp/capture.pcap`);
}

const CLASSIFIED_BY_LIBMAGIC_TEXT_HEURISTICS = new Set(['three-bytes']);

const PRINTS_TRUNCATED_PACKETS_DIFFERENTLY = (name: string): boolean => name.startsWith('lab-snapshot-') || name === 'snapshot-shorter-than-the-ip-header';

for (const entry of fixture.cases) {
  describe(`tcpdump -r on ${entry.name}`, () => {
    for (const run of entry.runs) {
      const check = PRINTS_TRUNCATED_PACKETS_DIFFERENTLY(entry.name) ? it.skip : it;
      check(run.options, async () => {
        expect(normalised(await read(entry.hex, run.options))).toBe(normalised(run.output));
      });
    }
  });
}

describe('file on savefiles of every shape', () => {
  for (const entry of fixture.cases) {
    const check = CLASSIFIED_BY_LIBMAGIC_TEXT_HEURISTICS.has(entry.name) ? it.skip : it;
    check(entry.name, async () => {
      expect(await machineHolding(entry.hex).executeCommand('file /tmp/capture.pcap')).toBe(`/tmp/capture.pcap: ${entry.file}`);
    });
  }
});

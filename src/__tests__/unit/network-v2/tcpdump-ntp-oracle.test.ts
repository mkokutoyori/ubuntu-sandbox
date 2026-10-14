/*
 * tcpdump printing NTP, against the real tcpdump 4.99.4 / libpcap 1.10.4 (Ubuntu 24.04).
 *
 * scripts/oracle/record_tcpdump_ntp.py writes each datagram into a pcap and records what the real binary prints at -nn, -nn -q,
 * -nn -v, -nn -vv, -nn -vvv and -nn -tt: every mode (including 0, 6, 7), versions 0-7, all kiss codes, leap indicators, reference
 * ids per stratum, poll and precision extremes, timestamps from 1900 to 2036, deltas with a borrowed fraction, a zero origin,
 * MD5 and SHA1 MACs, crypto-NAK, extension fields, truncated packets, control messages (R/E/M bits, opcodes, data) and real
 * chronyd replies.  The same bytes travel through the simulator's frame decoder and formatter; the whole line is compared.
 * Measured before TcpdumpNtp existed (git stash push -u -- src/network): every one of the NTP lines was "UDP, length N".
 * The -q cases are the witnesses: the real tool keeps "UDP, length N" there too, so they pass either way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { IPAddress, MACAddress, computeIPv4Checksum, type EthernetFrame } from '@/network/core/types';
import { buildUdpOverIpv4 } from '@/network/layers/transport/UdpEgress';
import { decodeEthernetFrame } from '@/network/devices/linux/network/tcpdump/CaptureFrame';
import { TcpdumpRenderState, formatFrame } from '@/network/devices/linux/network/tcpdump/TcpdumpFormat';
import { parseInvocation } from '@/network/devices/linux/network/tcpdump/TcpdumpCli';

interface Case { name: string; payload: string; src: string; dst: string; sport: number; dport: number; outputs: Record<string, string> }
const fixture = JSON.parse(readFileSync(new URL('../../support/oracle/tcpdump-ntp-4.99.4.json', import.meta.url), 'utf8')) as { cases: Case[] };
const bytes = (hex: string): Uint8Array => new Uint8Array(hex.match(/../g)?.map((h) => parseInt(h, 16)) ?? []);

function render(c: Case, options: string[]): string {
  const ip = buildUdpOverIpv4(new IPAddress(c.src), {
    destination: new IPAddress(c.dst), destinationPort: c.dport, sourcePort: c.sport, payload: bytes(c.payload), payloadBytes: c.payload.length / 2,
  });
  ip.identification = 0x1234;
  ip.headerChecksum = 0;
  ip.headerChecksum = computeIPv4Checksum(ip);
  const frame: EthernetFrame = { srcMAC: new MACAddress('52:54:00:00:00:01'), dstMAC: new MACAddress('52:54:00:00:00:02'), etherType: 0x0800, payload: ip };
  const invocation = parseInvocation(options);
  if (invocation.kind !== 'capture') throw new Error(`unexpected invocation ${invocation.kind}`);
  const captured = decodeEthernetFrame(frame, 'eth0', 'in', new Date(1760000000123), 1760000000123456);
  return formatFrame(captured, invocation.options, new TcpdumpRenderState()) + '\n';
}

describe('tcpdump prints NTP like the real tcpdump', () => {
  const sets = [['-nn'], ['-nn', '-v'], ['-nn', '-vv'], ['-nn', '-vvv'], ['-nn', '-tt']];
  for (const c of fixture.cases) {
    for (const options of sets) {
      const key = options.join(' ');
      it(`${c.name} ${key}`, () => {
        expect(render(c, options).replace(/^\d\d:\d\d:\d\d/, '08:53:20')).toBe(c.outputs[key].replace(/\n+$/, '\n'));
      });
    }
  }
  const quiet = fixture.cases.filter((c) => !c.name.startsWith('control') && !c.name.startsWith('chrony'));
  for (const c of quiet.slice(0, 8)) {
    it(`WITNESS ${c.name} -q keeps UDP, length N`, () => {
      expect(render(c, ['-nn', '-q'])).toBe(c.outputs['-nn -q'].replace(/\n+$/, '\n'));
    });
  }
});

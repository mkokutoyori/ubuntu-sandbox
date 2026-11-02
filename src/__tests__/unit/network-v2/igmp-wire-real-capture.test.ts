/**
 * IGMP against captures taken from real implementations.
 *
 * The messages and their printed text come from tests/IGMP_V1.pcap, IGMP_V2.pcap and igmpv3-queries.pcap with igmpv1.out,
 * igmpv2.out and igmpv3-queries.out in the tcpdump 4.99 source tree. They are the authority: the simulator's encoder is
 * checked byte for byte (checksum included) against every v1 and v2 message it can write, a general and a group-specific
 * query, v1 and v2 reports and a leave, and the printer against what the real tool printed for all of them, the IGMPv3
 * queries (which the simulator does not send) included.
 *
 * Before the change the encoder and the printer did not exist: all 23 cases fall (the module is absent). The checksum case is
 * the witness that the vectors are sound: the internet checksum of a real message, checksum field included, is zero.
 */
import { describe, expect, it } from 'vitest';
import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { igmpPayloadBytes, IGMP_MESSAGE_BYTES } from '@/network/igmp/IgmpWire';
import type { IgmpPacket } from '@/network/igmp/types';
import { igmpText } from '@/network/devices/linux/network/tcpdump/TcpdumpIgmp';
import { unsignedRelativeTime } from '@/network/devices/linux/network/tcpdump/TcpdumpTime';

const REAL = [
  { name: 'v1 0', pdu: '1100eeff00000000', text: "igmp query v1" },
  { name: 'v1 1', pdu: '12000d03e00000fc', text: "igmp v1 report 224.0.0.252" },
  { name: 'v1 2', pdu: '1200fe04effffffa', text: "igmp v1 report 239.255.255.250" },
  { name: 'v1 3', pdu: '12000ce7e0000118', text: "igmp v1 report 224.0.1.24" },
  { name: 'v2 0', pdu: '1164ee9b00000000', text: "igmp query v2" },
  { name: 'v2 1', pdu: '1600fa04effffffa', text: "igmp v2 report 239.255.255.250" },
  { name: 'v2 3', pdu: '160007fbe1010103', text: "igmp v2 report 225.1.1.3" },
  { name: 'v2 4', pdu: '170006fbe1010103', text: "igmp leave 225.1.1.3" },
  { name: 'v2 5', pdu: '110a0cf1e1010103', text: "igmp query v2 [max resp time 10] [gaddr 225.1.1.3]" },
  { name: 'v3 0', pdu: '1164ec1e00000000027d0000', text: "igmp query v3" },
  { name: 'v3 1', pdu: '11feeb8400000000027d0000', text: "igmp query v3 [max resp time 51m12s]" },
  { name: 'v3 3', pdu: '110aec7800000000027d0000', text: "igmp query v3 [max resp time 1.0s]" },
] as const;

function bytesOf(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

function message(messageType: IgmpPacket['messageType'], maxRespTimeDs: number, groupAddress: string): IgmpPacket {
  return { type: 'igmp', version: 2, messageType, maxRespTimeDs, groupAddress, checksum: 0 };
}

const WRITTEN: ReadonlyArray<readonly [string, IgmpPacket]> = [
  ['v1 0', message('membership-query', 0, '0.0.0.0')],
  ['v1 1', message('v1-membership-report', 0, '224.0.0.252')],
  ['v1 2', message('v1-membership-report', 0, '239.255.255.250')],
  ['v2 0', message('membership-query', 100, '0.0.0.0')],
  ['v2 1', message('v2-membership-report', 0, '239.255.255.250')],
  ['v2 3', message('v2-membership-report', 0, '225.1.1.3')],
  ['v2 4', message('leave-group', 0, '225.1.1.3')],
  ['v2 5', message('membership-query', 10, '225.1.1.3')],
];

describe('IGMP wire against real captures', () => {
  it('witness: the checksum of every real message, its own checksum included, is zero', () => {
    for (const vector of REAL.filter((entry) => entry.pdu.length === 16)) expect(internetChecksum(bytesOf(vector.pdu))).toBe(0);
  });

  for (const [name, packet] of WRITTEN) {
    it('writes ' + name + ' byte for byte', () => {
      const vector = REAL.find((entry) => entry.name === name);
      expect(igmpPayloadBytes(packet)).toEqual(bytesOf(vector?.pdu ?? ''));
      expect(igmpPayloadBytes(packet).length).toBe(IGMP_MESSAGE_BYTES);
    });
  }

  for (const vector of REAL) {
    it('prints ' + vector.name + ' like tcpdump', () => {
      const bytes = bytesOf(vector.pdu);
      expect(igmpText(bytes, bytes.length, 0, false, (address) => address)).toBe(vector.text);
    });
  }

  it('prints only the protocol name with -q', () => {
    const bytes = bytesOf(REAL[0].pdu);
    expect(igmpText(bytes, bytes.length, 0, true, (address) => address)).toBe('igmp');
  });

  it('writes a relative time the way tcpdump does', () => {
    expect(unsignedRelativeTime(3072)).toBe('51m12s');
    expect(unsignedRelativeTime(0)).toBe('0s');
    expect(unsignedRelativeTime(90061)).toBe('1d1h1m1s');
  });
});

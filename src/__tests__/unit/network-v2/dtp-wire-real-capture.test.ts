/**
 * DTP against a capture taken from a real Cisco switch.
 *
 * The PDU and its printed text are frame 1 of tests/DTP.pcap and tests/dtp-v.out in the tcpdump 4.99 source tree: a port in
 * dynamic auto mode, not trunking, encapsulation left on negotiate, domain Lab. It is the authority for the two bytes the
 * Wireshark dissector only names: the Trunk Status byte is 0x04 (access, administrative auto) and the Trunk Type byte is
 * 0x40, an operating type of ISL (2) with the administrative type negotiated (0). The simulator used to write NATIVE (1) for
 * every port that was not trunking; one case below fell with it (the encoder case), the printer cases pass either way
 * (witnesses that the printer already agreed with the real tool on a real PDU).
 */
import { describe, expect, it } from 'vitest';
import { dtpPayloadBytes } from '@/network/dtp/DtpWire';
import type { DtpFrame } from '@/network/dtp/types';
import { dtpText } from '@/network/devices/linux/network/tcpdump/TcpdumpDtp';

const REAL_PDU = '01000100084c61620000020005040003000540' + '0004000a001906eab885';
const REAL_TEXT = [
  'DTPv1, length 29',
  '\tDomain (0x0001) TLV, length 8, Lab',
  '\tStatus (0x0002) TLV, length 5, 0x4',
  '\tDTP type (0x0003) TLV, length 5, 0x40',
  '\tNeighbor (0x0004) TLV, length 10, 00:19:06:ea:b8:85',
].join('\n');

function bytesOf(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

describe('DTP wire against a real capture', () => {
  it('writes the PDU of a dynamic auto port that is not trunking byte for byte', () => {
    const frame = {
      type: 'dtp', domain: 'Lab', adminMode: 'dynamic-auto', operationalMode: 'access',
      trunkEncapsulation: 'negotiated', neighborMac: '00:19:06:ea:b8:85',
    } as DtpFrame;
    expect(dtpPayloadBytes(frame)).toEqual(bytesOf(REAL_PDU));
  });

  it('prints the real PDU like tcpdump -v', () => {
    const bytes = bytesOf(REAL_PDU);
    expect(dtpText(bytes, bytes.length, 1, (mac) => mac)).toBe(REAL_TEXT);
  });

  it('prints the one line of tcpdump without -v', () => {
    const bytes = bytesOf(REAL_PDU);
    expect(dtpText(bytes, bytes.length, 0, (mac) => mac)).toBe('DTPv1, length 29');
  });
});

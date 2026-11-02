/**
 * UDLD against a capture taken from real Cisco switches.
 *
 * The three PDUs and their printed text are frames 1, 2 and 12 of tests/UDLD.pcap and tests/udld-v.out in the tcpdump 4.99
 * source tree (two switches, serials FOC1031Z7JG and FOC1025X4W3, a Gi0/1 to Fa0/1 link). They are the authority: the
 * simulator's own encoder is checked byte for byte against the two PDUs whose flags it can write (the first probe of the
 * capture also carries the ReSynch flag, which the simulator has no state to raise, so it is only printed), and the printer
 * is checked against what the real tool printed for all three.
 *
 * Before the change the encoder and the printer did not exist: all 7 cases below fall (the module is absent). The checksum
 * case is the witness that the vectors are sound: the internet checksum of a real PDU, checksum field included, is zero.
 */
import { describe, expect, it } from 'vitest';
import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { udldPayloadBytes } from '@/network/udld/UdldWire';
import type { UdldPacket } from '@/network/udld/types';
import { udldText } from '@/network/devices/linux/network/tcpdump/TcpdumpUdld';

const REAL = {
  firstProbe: {
    pdu: '21036d850001000f464f43313033315a374a47000200094769302f310003000800000000000400050700050005050006000653310007000800000001',
    text: "UDLDv1, Code Probe message (1), Flags [RT, RSY] (0x03), length 60\n\tChecksum 0x6d85 (unverified)\n\tDevice-ID TLV (0x0001) TLV, length 15, FOC1031Z7JG\n\tPort-ID TLV (0x0002) TLV, length 9, Gi0/1\n\tEcho TLV (0x0003) TLV, length 8, ^@^@^@^@\n\tMessage Interval TLV (0x0004) TLV, length 5, 7s\n\tTimeout Interval TLV (0x0005) TLV, length 5, 5s\n\tDevice Name TLV (0x0006) TLV, length 6, S1\n\tSequence Number TLV (0x0007) TLV, length 8, 1",
  },
  echoFromS2: {
    pdu: '2200805d0001000f464f433130323558345733000200094661302f310003001c00000001000b464f43313033315a374a4700054769302f31000400050700050005050006000653320007000800000001',
    text: "UDLDv1, Code Echo message (2), Flags [none] (0x00), length 80\n\tChecksum 0x805d (unverified)\n\tDevice-ID TLV (0x0001) TLV, length 15, FOC1025X4W3\n\tPort-ID TLV (0x0002) TLV, length 9, Fa0/1\n\tEcho TLV (0x0003) TLV, length 28, ^@^@^@^A^@^KFOC1031Z7JG^@^EGi0/1\n\tMessage Interval TLV (0x0004) TLV, length 5, 7s\n\tTimeout Interval TLV (0x0005) TLV, length 5, 5s\n\tDevice Name TLV (0x0006) TLV, length 6, S2\n\tSequence Number TLV (0x0007) TLV, length 8, 1",
  },
  probeFromS2: {
    pdu: '2101795c0001000f464f433130323558345733000200094661302f310003001c00000001000b464f43313033315a374a4700054769302f31000400050f00050005050006000653320007000800000001',
    text: "UDLDv1, Code Probe message (1), Flags [RT] (0x01), length 80\n\tChecksum 0x795c (unverified)\n\tDevice-ID TLV (0x0001) TLV, length 15, FOC1025X4W3\n\tPort-ID TLV (0x0002) TLV, length 9, Fa0/1\n\tEcho TLV (0x0003) TLV, length 28, ^@^@^@^A^@^KFOC1031Z7JG^@^EGi0/1\n\tMessage Interval TLV (0x0004) TLV, length 5, 15s\n\tTimeout Interval TLV (0x0005) TLV, length 5, 5s\n\tDevice Name TLV (0x0006) TLV, length 6, S2\n\tSequence Number TLV (0x0007) TLV, length 8, 1",
  },
} as const;

function bytesOf(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

function switchTwoPacket(opcode: UdldPacket['opcode'], intervalSec: number): UdldPacket {
  return {
    type: 'udld', version: 1, opcode,
    senderDeviceId: 'FOC1025X4W3', senderPortId: 'Fa0/1', senderHostname: 'S2',
    helloIntervalSec: intervalSec, messageInterval: intervalSec, timeoutInterval: 5, sequence: 1,
    echo: [{ deviceId: 'FOC1031Z7JG', portId: 'Gi0/1' }],
  } as UdldPacket;
}

describe('UDLD wire against a real capture', () => {
  it('witness: the checksum of a real PDU, its own checksum included, is zero', () => {
    for (const vector of Object.values(REAL)) expect(internetChecksum(bytesOf(vector.pdu))).toBe(0);
  });

  it('writes the echo of the second switch byte for byte', () => {
    expect(udldPayloadBytes(switchTwoPacket('echo', 7))).toEqual(bytesOf(REAL.echoFromS2.pdu));
  });

  it('writes the later probe of the second switch byte for byte', () => {
    expect(udldPayloadBytes(switchTwoPacket('probe', 15))).toEqual(bytesOf(REAL.probeFromS2.pdu));
  });

  for (const [name, vector] of Object.entries(REAL)) {
    it('prints ' + name + ' like tcpdump -v', () => {
      const bytes = bytesOf(vector.pdu);
      expect(udldText(bytes, bytes.length, 1)).toBe(vector.text);
    });
  }

  it('prints the one line of tcpdump without -v', () => {
    const bytes = bytesOf(REAL.firstProbe.pdu);
    expect(udldText(bytes, bytes.length, 0)).toBe('UDLDv1, Code Probe message (1), Flags [RT, RSY] (0x03), length 60');
  });
});

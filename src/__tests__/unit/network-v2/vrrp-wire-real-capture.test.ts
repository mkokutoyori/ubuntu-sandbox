/**
 * VRRP against a capture taken from a real implementation.
 *
 * The three PDUs and their printed text are frames 1, 2 and 3 of tests/vrrp.pcap, vrrp.out and vrrp-v.out in the tcpdump 4.99
 * source tree (virtual router 42 with a simple password, 43 without authentication, and a VRRPv3 advertisement). They are the
 * authority: the simulator's VRRPv2 encoder is checked byte for byte against the first two (checksum included), the printer
 * against what the real tool printed for all three. The simulator has no VRRPv3, so that PDU is only printed.
 *
 * Before the change the encoder and the printer did not exist: all 7 cases fall (the module is absent). The checksum case is the
 * witness that the vectors are sound: the internet checksum of a real VRRPv2 message, checksum field included, is zero.
 */
import { describe, expect, it } from 'vitest';
import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { vrrpPayloadBytes, vrrpWireLength } from '@/network/vrrp/VrrpWire';
import type { VrrpPacket } from '@/network/vrrp/types';
import { vrrpText } from '@/network/devices/linux/network/tcpdump/TcpdumpVrrp';

const REAL = {
  simplePassword: {
    pdu: '212abf03010af11f0a042a010a042a020a042a036162636465666768',
    quiet: 'VRRPv2, Advertisement, vrid 42, prio 191, authtype simple, intvl 10s, length 28',
    verbose: 'VRRPv2, Advertisement, vrid 42, prio 191, authtype simple, intvl 10s, length 28, addrs(3): 10.4.42.1,10.4.42.2,10.4.42.3 auth "abcdefgh"',
  },
  noAuthentication: {
    pdu: '212bbf01000aea2e0a042b960000000000000000',
    quiet: 'VRRPv2, Advertisement, vrid 43, prio 191, authtype none, intvl 10s, length 20',
    verbose: 'VRRPv2, Advertisement, vrid 43, prio 191, authtype none, intvl 10s, length 20, addrs: 10.4.43.150',
  },
  versionThree: {
    pdu: '312cbf0203e8b3c60a042c640a042cc8',
    quiet: 'VRRPv3, Advertisement, vrid 44, prio 191, intvl 1000cs, length 16',
    verbose: 'VRRPv3, Advertisement, vrid 44, prio 191, intvl 1000cs, length 16, addrs(2): 10.4.44.100,10.4.44.200',
  },
} as const;

function bytesOf(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

function packet(vrid: number, vips: string[], authType: number, authData?: string): VrrpPacket {
  return { type: 'vrrp', version: 2, vrid, priority: 191, advertiseSec: 10, vips, senderIp: '10.0.0.91', authType, authData } as VrrpPacket;
}

describe('VRRP wire against a real capture', () => {
  it('witness: the checksum of a real VRRPv2 message, its own checksum included, is zero', () => {
    expect(internetChecksum(bytesOf(REAL.simplePassword.pdu))).toBe(0);
    expect(internetChecksum(bytesOf(REAL.noAuthentication.pdu))).toBe(0);
  });

  it('writes the advertisement with a simple password and three addresses byte for byte', () => {
    const advertisement = packet(42, ['10.4.42.1', '10.4.42.2', '10.4.42.3'], 1, 'abcdefgh');
    expect(vrrpPayloadBytes(advertisement)).toEqual(bytesOf(REAL.simplePassword.pdu));
    expect(vrrpWireLength(advertisement)).toBe(28);
  });

  it('writes the advertisement without authentication byte for byte, the eight data bytes zero-filled', () => {
    const advertisement = packet(43, ['10.4.43.150'], 0);
    expect(vrrpPayloadBytes(advertisement)).toEqual(bytesOf(REAL.noAuthentication.pdu));
    expect(vrrpWireLength(advertisement)).toBe(20);
  });

  for (const [name, vector] of Object.entries(REAL)) {
    it('prints ' + name + ' like tcpdump and tcpdump -v', () => {
      const bytes = bytesOf(vector.pdu);
      expect(vrrpText(bytes, bytes.length, 255, 0, (address) => address)).toBe(vector.quiet);
      expect(vrrpText(bytes, bytes.length, 255, 1, (address) => address)).toBe(vector.verbose);
    });
  }

  it('says so when the time to live is not 255, as print-vrrp.c does', () => {
    const bytes = bytesOf(REAL.noAuthentication.pdu);
    expect(vrrpText(bytes, bytes.length, 64, 0, (address) => address)).toBe('VRRPv2, Advertisement, (ttl 64), vrid 43, prio 191, authtype none, intvl 10s, length 20');
  });
});

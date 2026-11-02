/**
 * HSRP against captures taken from real Cisco routers.
 *
 * The six PDUs and their printed text come from tests/HSRP_coup.pcap, HSRP_election.pcap and HSRP_failover.pcap with
 * hsrp_1-v.out, hsrp_2-v.out and hsrp_3-v.out in the tcpdump 4.99 source tree (192.168.0.0/24, group 1, virtual address
 * 192.168.0.1, authentication text cisco). The captures are the authority: HSRP is Cisco's, RFC 2281 is informative and
 * describes version 1 only, so the layout is what the routers wrote. The simulator's encoder is checked byte for byte against
 * the four messages it can write (an active hello, a standby hello, a speak hello and a coup), the printer against what the
 * real tool printed for all six, the two 16-byte messages of group 2 and 3 (an opcode 3 that the simulator never sends)
 * included.
 *
 * Before the change the encoder and the printer did not exist: all 13 cases fall (the module is absent). The length case is
 * the witness that the vectors are sound: every hello and coup of the capture is HSRP_MESSAGE_BYTES long.
 */
import { describe, expect, it } from 'vitest';
import { hsrpPayloadBytes, hsrpIsEncodable, HSRP_MESSAGE_BYTES } from '@/network/hsrp/HsrpWire';
import type { HsrpPacket, HsrpOpcode, HsrpState } from '@/network/hsrp/types';
import { hsrpText } from '@/network/devices/linux/network/tcpdump/TcpdumpHsrp';

const REAL = {
  activeHello: {
    pdu: '000010030a640100636973636f000000c0a80001',
    text: "HSRPv0-hello 20: state=active group=1 addr=192.168.0.1 hellotime=3s holdtime=10s priority=100 auth=\"cisco\"",
  },
  standbyHello: {
    pdu: '000008030a640100636973636f000000c0a80001',
    text: "HSRPv0-hello 20: state=standby group=1 addr=192.168.0.1 hellotime=3s holdtime=10s priority=100 auth=\"cisco\"",
  },
  unknownOpcodeOne: {
    pdu: '00030001000e0200000000016f000000',
    text: "HSRPv0-unknown (3) 16: state=initial group=2  [|hsrp]",
  },
  unknownOpcodeTwo: {
    pdu: '00030001000e0300000100026f000000',
    text: "HSRPv0-unknown (3) 16: state=initial group=3  [|hsrp]",
  },
  coup: {
    pdu: '000102030ac80100636973636f000000c0a80001',
    text: "HSRPv0-coup 20: state=listen group=1 addr=192.168.0.1 hellotime=3s holdtime=10s priority=200 auth=\"cisco\"",
  },
  speakHello: {
    pdu: '000004030a640100636973636f000000c0a80001',
    text: "HSRPv0-hello 20: state=speak group=1 addr=192.168.0.1 hellotime=3s holdtime=10s priority=100 auth=\"cisco\"",
  },
} as const;

function bytesOf(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

function message(opcode: HsrpOpcode, state: HsrpState, priority: number): HsrpPacket {
  return {
    type: 'hsrp', version: 1, opcode, state, helloSec: 3, holdSec: 10, priority, group: 1,
    authText: 'cisco', vip: '192.168.0.1', senderIp: '192.168.0.30',
  } as HsrpPacket;
}

describe('HSRP wire against a real capture', () => {
  it('witness: every hello and coup of the capture is as long as the message the simulator sizes', () => {
    for (const name of ['activeHello', 'standbyHello', 'coup', 'speakHello'] as const) expect(bytesOf(REAL[name].pdu).length).toBe(HSRP_MESSAGE_BYTES);
  });

  it('writes the active hello byte for byte', () => {
    expect(hsrpPayloadBytes(message('hello', 'active', 100))).toEqual(bytesOf(REAL.activeHello.pdu));
  });

  it('writes the standby hello byte for byte', () => {
    expect(hsrpPayloadBytes(message('hello', 'standby', 100))).toEqual(bytesOf(REAL.standbyHello.pdu));
  });

  it('writes the speak hello byte for byte', () => {
    expect(hsrpPayloadBytes(message('hello', 'speak', 100))).toEqual(bytesOf(REAL.speakHello.pdu));
  });

  it('writes the coup of a listening router byte for byte', () => {
    expect(hsrpPayloadBytes(message('coup', 'listen', 200))).toEqual(bytesOf(REAL.coup.pdu));
  });

  it('encodes only HSRPv1, the version RFC 2281 describes', () => {
    expect(hsrpIsEncodable(message('hello', 'active', 100))).toBe(true);
    expect(hsrpIsEncodable({ ...message('hello', 'active', 100), version: 2 })).toBe(false);
  });

  for (const [name, vector] of Object.entries(REAL)) {
    it('prints ' + name + ' like tcpdump -v', () => {
      const bytes = bytesOf(vector.pdu);
      expect(hsrpText(bytes, bytes.length, 1, (address) => address)).toBe(vector.text);
    });
  }

  it('prints the shorter line of tcpdump without -v', () => {
    const bytes = bytesOf(REAL.activeHello.pdu);
    expect(hsrpText(bytes, bytes.length, 0, (address) => address)).toBe('HSRPv0-hello 20: state=active group=1 addr=192.168.0.1');
  });
});

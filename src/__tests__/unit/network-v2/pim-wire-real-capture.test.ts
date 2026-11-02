/**
 * PIM against captures taken from real routers.
 *
 * The messages and their printed text come from tests/PIMv2_hellos.pcap, PIM-SM_join_prune.pcap, PIMv2_bootstrap.pcap and
 * PIM_register_register-stop.pcap with pimv2_hellos-v.out, pimv2_sm-v.out, pimv2_bootstrap-v.out and pimv2_register-v.out in
 * the tcpdump 4.99 source tree. They are the authority: the simulator's encoder is checked byte for byte (checksum included)
 * against a Hello, a (*,G) Join, a Bootstrap and a Candidate-RP-Advertisement, the printer against what the real tool printed
 * for those four and for a Register-Stop, which the simulator never sends.
 *
 * Before the change the encoder and the printer did not exist: all 11 cases fall (the module is absent). The checksum case is
 * the witness that the vectors are sound: the internet checksum of a real message, checksum field included, is zero.
 */
import { describe, expect, it } from 'vitest';
import { internetChecksum } from '@/network/layers/transport/L4Checksum';
import { pimPayloadBytes, pimWireLength } from '@/network/pim/PimWire';
import type { PimPacket } from '@/network/pim/types';
import { pimText } from '@/network/devices/linux/network/tcpdump/TcpdumpPim';

const REAL = {
  hello: {
    pdu: '2000aa6e000100020069001400043f0ef4cd00130004000000010015000401000000',
    text: 'PIMv2, length 34\n\tHello, cksum 0xaa6e (correct)\n\t  Hold Time Option (1), length 2, Value: 1m45s\n\t  Generation ID Option (20), length 4, Value: 0x3f0ef4cd\n\t  DR Priority Option (19), length 4, Value: 1\n\t  State Refresh Capability Option (21), length 4, Value: v1',
  },
  join: {
    pdu: '23005ae501000a00000d000100d201000020ef7b7b7b000100000100072001010101',
    text: 'PIMv2, length 34\n\tJoin / Prune, cksum 0x5ae5 (correct), upstream-neighbor: 10.0.0.13\n\t  1 group(s), holdtime: 3m30s\n\t    group #1: 239.123.123.123, joined sources: 1, pruned sources: 0\n\t      joined source #1: 1.1.1.1(SWR)',
  },
  bootstrap: {
    pdu: '2400e41004b0000001000101010101000004e0000000020200000100020202020096000001000303030300960000',
    text: 'PIMv2, length 46\n\tBootstrap, cksum 0xe410 (correct) tag=4b0 hashmlen=0 BSRprio=0 BSR=1.1.1.1 (group0: 224.0.0.0/4 RPcnt=2 FRPcnt=2 RP0=2.2.2.2,holdtime=2m30s,prio=0 RP1=3.3.3.3,holdtime=2m30s,prio=0)',
  },
  candidateRp: {
    pdu: '2800ee5e0100009601000303030301000004e0000000',
    text: 'PIMv2, length 22\n\tCandidate RP Advertisement, cksum 0xee5e (correct) prefix-cnt=1 prio=0 holdtime=2m30s RP=3.3.3.3 Group0=224.0.0.0/4',
  },
  registerStop: {
    pdu: '2200162801000020ef0102030100c0a8140a',
    text: 'PIMv2, length 18\n\tRegister Stop, cksum 0x1628 (correct) group=239.1.2.3 source=192.168.20.10',
  },
} as const;

function bytesOf(hex: string): number[] {
  return (hex.match(/../g) ?? []).map((pair) => parseInt(pair, 16));
}

function message(messageType: PimPacket['messageType'], fill: Partial<PimPacket>): PimPacket {
  return { type: 'pim', version: 2, messageType, reserved: 0, checksum: 0, options: [], senderIp: '10.0.0.2', ...fill } as PimPacket;
}

describe('PIM wire against real captures', () => {
  it('witness: the checksum of every real message, its own checksum included, is zero', () => {
    for (const vector of Object.values(REAL)) expect(internetChecksum(bytesOf(vector.pdu))).toBe(0);
  });

  it('writes the Hello byte for byte', () => {
    const hello = message('hello', {
      options: [
        { type: 'holdtime', value: 105 }, { type: 'generation-id', value: 0x3f0ef4cd },
        { type: 'dr-priority', value: 1 }, { type: 'state-refresh', value: 0 },
      ],
    });
    expect(pimPayloadBytes(hello)).toEqual(bytesOf(REAL.hello.pdu));
    expect(pimWireLength(hello)).toBe(34);
  });

  it('writes the (*,G) Join, the rendezvous point travelling as the S, W and R source', () => {
    const join = message('join-prune', {
      joinPrune: {
        upstreamNeighborIp: '10.0.0.13', holdtimeSec: 210,
        groups: [{ groupAddress: '239.123.123.123', joinedSources: [], prunedSources: [], joinStarG: true, pruneStarG: false, rpAddress: '1.1.1.1' }],
      },
    });
    expect(pimPayloadBytes(join)).toEqual(bytesOf(REAL.join.pdu));
  });

  it('writes the Bootstrap byte for byte', () => {
    const bootstrap = message('bootstrap', {
      bootstrap: {
        bsrAddress: '1.1.1.1', bsrPriority: 0, fragmentTag: 0x4b0,
        groups: [{
          groupRangeAddress: '224.0.0.0', groupRangeMaskBits: 4,
          rps: [{ rpAddress: '2.2.2.2', priority: 0, holdtimeSec: 150 }, { rpAddress: '3.3.3.3', priority: 0, holdtimeSec: 150 }],
        }],
      },
    });
    expect(pimPayloadBytes(bootstrap)).toEqual(bytesOf(REAL.bootstrap.pdu));
  });

  it('writes the Candidate-RP-Advertisement byte for byte', () => {
    const advertisement = message('candidate-rp-advertisement', {
      candidateRp: { rpAddress: '3.3.3.3', priority: 0, holdtimeSec: 150, groups: [{ groupRangeAddress: '224.0.0.0', groupRangeMaskBits: 4 }] },
    });
    expect(pimPayloadBytes(advertisement)).toEqual(bytesOf(REAL.candidateRp.pdu));
  });

  for (const [name, vector] of Object.entries(REAL)) {
    it('prints ' + name + ' like tcpdump -v', () => {
      const bytes = bytesOf(vector.pdu);
      expect(pimText(bytes, bytes.length, 1, (address) => address)).toBe(vector.text);
    });
  }

  it('prints the one line of tcpdump without -v', () => {
    const bytes = bytesOf(REAL.hello.pdu);
    expect(pimText(bytes, bytes.length, 0, (address) => address)).toBe('PIMv2, Hello, length 34');
  });
});

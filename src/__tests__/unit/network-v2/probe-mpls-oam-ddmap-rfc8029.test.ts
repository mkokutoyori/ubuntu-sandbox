/**
 * Probe: MPLS LSP traceroute with the Downstream Detailed Mapping TLV
 * (docs/rfc/mpls/rfc8029.txt §3.4, §4.4 steps 4-6, §4.6).
 * A chain of four LDP routers R1-R4 (loopback LSR ids 101-104), FEC 9.9.9.0/24 owned by R4,
 * full static routing so every router can answer the originator.
 * Before the change: all 14 cases fail (the TLV was refused with code 2, the responder never
 * built a mapping, there was no traceroute, and the FEC stack module does not exist).
 * The witness (a request without the TLV gets no mapping back and code 8) and the two
 * refusals (wrong downstream, IPv6 address type) prove the lab and the checks are not
 * vacuous once the feature exists.
 * Interpretation recorded: the label stack sub-TLV is written top first, as on the wire;
 * the multipath sub-TLV is always type 0 (no ECMP: a router here has one next hop),
 * and the incoming Multipath Information is therefore not evaluated.
 * Not built (TODO.md [mpls-oam]): IPv6 address types (refused as an unsupported mandatory
 * TLV, never ignored), the V flag at a transit router, ECMP, and any router that emits
 * a FEC stack change; the originator side of the FEC stack change algorithm (§4.6)
 * is covered on crafted input.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { IPAddress } from '@/network/core/types';
import {
  DDMAP_ALL_ROUTERS, DDMAP_UNKNOWN_DOWNSTREAM, DdmapProtocol, EchoMessageType, ReturnCode,
  decodeEcho, encodeEcho, newEchoMessage, type Ddmap, type TargetFec,
} from '@/network/mpls/oam/EchoCodec';
import { fecStackAfter } from '@/network/mpls/oam/FecStackChange';
import { ldpChain, lsr } from './_ldp-chain-lab';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

const FEC: TargetFec = { kind: 'ldp-ipv4', prefix: new IPAddress('9.9.9.0'), length: 24 };
const addr = (text: string) => new IPAddress(text);

const sample: Ddmap = {
  mtu: 1500, addressType: 1, interfaceAndLabelStackRequested: true, nonIp: false,
  downstreamAddress: addr('10.1.0.2'), downstreamInterface: addr('10.1.0.2'), returnCode: 0, returnSubcode: 0,
  multipathType: 0, multipathInformation: new Uint8Array(0),
  labelStack: [{ label: 3, protocol: 3 }, { label: 1000, protocol: 2 }],
  fecStackChanges: [{ operation: 'push', peer: addr('10.1.0.2'), fec: FEC }, { operation: 'pop', peer: null, fec: null }],
};

const lab = () => ldpChain(clock, { length: 4, fullRouting: true });
const labelOf = (router: Awaited<ReturnType<typeof lab>>[number]) => router.getLdpEngine().bindings()
  .find(binding => String(binding.fec.prefix) === '9.9.9.0')!.label.value;

function mapping(downstream: string, labels: number[], overrides: Partial<Ddmap> = {}): Ddmap {
  return {
    ...sample, interfaceAndLabelStackRequested: false, downstreamAddress: addr(downstream), downstreamInterface: addr(downstream),
    labelStack: labels.map(label => ({ label, protocol: DdmapProtocol.Ldp })), fecStackChanges: [], ...overrides,
  };
}

describe('Downstream Detailed Mapping wire format (§3.4)', () => {
  it('the TLV is type 20 with the fixed part, then sub-TLVs, and round-trips with its label stack and FEC stack changes', () => {
    const bytes = encodeEcho(newEchoMessage({ messageType: EchoMessageType.Request, senderHandle: 1, sequenceNumber: 1, targetFecs: [FEC], ddmaps: [sample] }));
    const decoded = decodeEcho(bytes);
    expect(decoded.ddmaps).toEqual([sample]);
    const start = 32 + 16;
    expect(Array.from(bytes.subarray(start, start + 2))).toEqual([0, 20]);
    const valueLength = (bytes[start + 2] << 8) | bytes[start + 3];
    expect(start + 4 + valueLength).toBe(bytes.length);
    const fixed = bytes.subarray(start + 4, start + 20);
    expect(Array.from(fixed.subarray(0, 4))).toEqual([0x05, 0xdc, 1, 0x2]);
    expect(Array.from(fixed.subarray(4, 12))).toEqual([10, 1, 0, 2, 10, 1, 0, 2]);
    expect((fixed[14] << 8) | fixed[15]).toBe(valueLength - 16);
  });

  it('an address type this code cannot carry (IPv6) is kept as an unsupported mandatory TLV, never ignored', () => {
    const bytes = encodeEcho(newEchoMessage({ messageType: EchoMessageType.Request, senderHandle: 1, sequenceNumber: 1, targetFecs: [FEC], ddmaps: [sample] }));
    const start = 32 + 16;
    const edited = Uint8Array.from(bytes);
    edited[start + 4 + 2] = 3;
    expect(decodeEcho(edited).unrecognisedMandatory.map(tlv => tlv.type)).toEqual([20]);
    expect(decodeEcho(edited).ddmaps).toHaveLength(0);
  });
});

describe('traceroute with DDMAP over a real LDP chain (§4.4, §4.6)', () => {
  it('walks R1 -> R4: a transit reply from each LSR with code 8, then the egress with code 3', async () => {
    const [first] = await lab();
    const hops = first.getMplsOam().traceroute([FEC]);
    expect(hops.map(hop => hop.outcome.kind === 'reply' ? hop.outcome.reply.message.returnCode : -1))
      .toEqual([ReturnCode.Switched, ReturnCode.Switched, ReturnCode.Egress]);
    expect(hops.map(hop => hop.outcome.kind === 'reply' ? String(hop.outcome.reply.from) : '')).toEqual([lsr(1), lsr(2), lsr(3)]);
  });

  it('each transit reply carries the downstream: next hop address, MTU, the label stack it would forward and the protocol (§3.4)', async () => {
    const routers = await lab();
    const hops = routers[0].getMplsOam().traceroute([FEC]);
    expect(hops[0].downstream).toMatchObject({
      addressType: 1, mtu: 1500, returnCode: 0, multipathType: 0,
      labelStack: [{ label: labelOf(routers[2]), protocol: DdmapProtocol.Ldp }],
    });
    expect(String(hops[0].downstream!.downstreamAddress)).toBe('10.1.0.2');
    expect(String(hops[0].downstream!.downstreamInterface)).toBe('10.1.0.2');
  });

  it('the hop before the egress reports Implicit Null explicitly in its label stack (§3.4.1.2)', async () => {
    const routers = await lab();
    const hops = routers[0].getMplsOam().traceroute([FEC]);
    expect(hops[1].downstream!.labelStack).toEqual([{ label: 3, protocol: DdmapProtocol.Ldp }]);
    expect(String(hops[1].downstream!.downstreamAddress)).toBe('10.2.0.2');
  });

  it('the egress reply carries no mapping (§3.4)', async () => {
    const [first] = await lab();
    expect(first.getMplsOam().traceroute([FEC]).at(-1)!.downstream).toBeNull();
  });

  it('a DDMAP naming the wrong downstream is answered Downstream Mapping Mismatch with the Interface and Label Stack TLV (§4.4 step 4)', async () => {
    const [first] = await lab();
    const outcome = first.getMplsOam().ping([FEC], { ttl: 1, ddmap: mapping('10.9.9.9', [labelOf((await lab())[1])]) });
    expect(outcome.kind).toBe('reply');
    if (outcome.kind !== 'reply') return;
    expect(outcome.reply.message.returnCode).toBe(ReturnCode.DownstreamMismatch);
    expect(outcome.reply.message.interfaceAndLabelStack).not.toBeNull();
    expect(outcome.reply.message.ddmaps).toHaveLength(0);
  });

  it('127.0.0.1 as downstream bypasses the interface check: code 6 with the Interface and Label Stack TLV and a mapping', async () => {
    const [first] = await lab();
    const outcome = first.getMplsOam().ping([FEC], { ttl: 1, ddmap: mapping(DDMAP_UNKNOWN_DOWNSTREAM, []) });
    expect(outcome.kind === 'reply' && outcome.reply.message).toMatchObject({ returnCode: ReturnCode.UpstreamInterfaceUnknown });
    expect(outcome.kind === 'reply' && outcome.reply.message.interfaceAndLabelStack).not.toBeNull();
    expect(outcome.kind === 'reply' && outcome.reply.message.ddmaps).toHaveLength(1);
  });

  it('224.0.0.2 as downstream bypasses interface and label validation and still returns the mapping (§3.4)', async () => {
    const [first] = await lab();
    const outcome = first.getMplsOam().ping([FEC], { ttl: 1, ddmap: mapping(DDMAP_ALL_ROUTERS, []) });
    expect(outcome.kind === 'reply' && outcome.reply.message).toMatchObject({ returnCode: ReturnCode.Switched });
    expect(outcome.kind === 'reply' && outcome.reply.message.ddmaps).toHaveLength(1);
  });

  it('the egress also checks the DDMAP against its receipt: a wrong interface gives code 5 (step 5)', async () => {
    const [first] = await lab();
    const outcome = first.getMplsOam().ping([FEC], { ttl: 3, ddmap: mapping('10.9.9.9', [3]) });
    expect(outcome.kind === 'reply' && outcome.reply.message.returnCode).toBe(ReturnCode.DownstreamMismatch);
  });

  it('the I flag asks the replier for the Interface and Label Stack TLV (§3.4)', async () => {
    const [first] = await lab();
    const outcome = first.getMplsOam().ping([FEC], { ttl: 1, ddmap: mapping(DDMAP_ALL_ROUTERS, [], { interfaceAndLabelStackRequested: true }) });
    expect(outcome.kind === 'reply' && outcome.reply.message.interfaceAndLabelStack).not.toBeNull();
  });

  it('WITNESS: a request without the TLV gets no mapping back, and the transit still answers code 8', async () => {
    const [first] = await lab();
    const outcome = first.getMplsOam().ping([FEC], { ttl: 1 });
    expect(outcome.kind === 'reply' && outcome.reply.message).toMatchObject({ returnCode: ReturnCode.Switched, ddmaps: [] });
  });
});

describe('FEC stack change processing by the originator (§4.6)', () => {
  const change = (operation: 'push' | 'pop', fec: TargetFec | null = null) => ({ operation, peer: null, fec });
  const other: TargetFec = { kind: 'ldp-ipv4', prefix: addr('1.1.1.1'), length: 32 };

  it('pops then pushes in order, on the traced stack only', () => {
    expect(fecStackAfter([FEC], [change('pop'), change('push', other)])).toEqual([other]);
    expect(fecStackAfter([FEC], [change('push', other)])).toEqual([other, FEC]);
  });

  it('a pop after a push is dropped, a pop on an empty stack is dropped, and an emptied stack is dropped', () => {
    expect(fecStackAfter([FEC], [change('push', other), change('pop')])).toBeNull();
    expect(fecStackAfter([], [change('pop')])).toBeNull();
    expect(fecStackAfter([FEC], [change('pop')])).toBeNull();
  });
});

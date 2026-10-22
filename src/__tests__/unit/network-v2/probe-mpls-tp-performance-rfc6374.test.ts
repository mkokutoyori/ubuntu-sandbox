/**
 * Probe: MPLS loss and delay measurement over the static LSP pair A - B - C
 * (docs/rfc/mpls/rfc6374.txt §2.2, §2.4, §3.1, §3.2, §3.4, §4.2, §4.3).
 * DM: the querier writes T1 in the Timestamp 1 field, the responder T2 (receive) and
 * T3 (transmit) and copies T1 and T2 into Timestamp 3 and 4, the querier reads T4 on
 * receipt: two-way delay = (T4 - T1) - (T3 - T2), real propagation time carried by the
 * cables. Formats: PTP truncated (3, the mandatory default) and NTP (2); the responder
 * answers in the querier's format when it can, else in its preferred one.
 * LM (direct): Counter 1..4 carry A_TxP, B_RxP, B_TxP, A_RxP, and the loss between two
 * responses is the difference of the transmit deltas minus the receive deltas in each
 * direction; the G-ACh itself is excluded from the scope (§4.2.8).
 * New: all 12 cases fail before (no message codec, no engines, no client LSP traffic).
 * Witness: with no packet dropped the measured loss is exactly 0 in both directions.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import {
  PM_VERSION, QueryControlCode, ResponseControlCode, TimestampFormat, decodeDelay, decodeLoss, encodeDelay, encodeLoss,
} from '@/network/mpls/tp/PerformanceMessages';
import { decodeTimestamp, encodeTimestamp } from '@/network/mpls/tp/TpPerformance';
import { createIPv4Packet, IP_PROTO_ICMP, type ICMPPacket } from '@/network/core/types';
import { ChannelType } from '@/network/mpls/tp/GachPacket';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

const ip = (text: string) => new IPAddress(text);

async function lab() {
  const [a, b, c] = [new CiscoRouter('A'), new CiscoRouter('B'), new CiscoRouter('C')];
  new Cable('ab').connect(a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
  new Cable('bc').connect(b.getPort('GigabitEthernet0/1')!, c.getPort('GigabitEthernet0/0')!);
  await run(a, ['interface GigabitEthernet0/0', 'ip address 10.1.0.1 255.255.255.0', 'no shutdown']);
  await run(b, ['interface GigabitEthernet0/0', 'ip address 10.1.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.2.0.2 255.255.255.0', 'no shutdown']);
  await run(c, ['interface GigabitEthernet0/0', 'ip address 10.2.0.3 255.255.255.0', 'no shutdown']);
  a.getMplsTpEngine().defineIngress({ name: 'ac', iface: 'GigabitEthernet0/0', nextHop: ip('10.1.0.2'), outLabel: 1001 });
  b.getMplsTpEngine().defineTransit({ inLabel: 1001, iface: 'GigabitEthernet0/1', nextHop: ip('10.2.0.3'), outLabel: 1002 });
  c.getMplsTpEngine().defineEgress({ name: 'ac', inLabel: 1002 });
  c.getMplsTpEngine().defineIngress({ name: 'ca', iface: 'GigabitEthernet0/0', nextHop: ip('10.2.0.2'), outLabel: 2001 });
  b.getMplsTpEngine().defineTransit({ inLabel: 2001, iface: 'GigabitEthernet0/0', nextHop: ip('10.1.0.1'), outLabel: 2002 });
  a.getMplsTpEngine().defineEgress({ name: 'ca', inLabel: 2002 });
  a.getTpPerformanceEngine().bindReturn('ca', 'ac');
  c.getTpPerformanceEngine().bindReturn('ac', 'ca');
  return { a, b, c };
}


const wireIp = (id: number) => createIPv4Packet(ip('10.0.0.1'), ip('10.0.0.2'), IP_PROTO_ICMP, 60,
  { type: 'icmp', icmpType: 'echo-request', code: 0, id, sequence: 1, dataSize: 8 } as ICMPPacket, 16);

describe('message codec (RFC 6374 §3)', () => {
  it('a DM query is 44 bytes: version 0, flags R=0 T=1, QTF in the high nibble, 26-bit session id and 6-bit DS', () => {
    const bytes = encodeDelay({
      response: false, controlCode: QueryControlCode.InBandResponse, querierTimestampFormat: TimestampFormat.Ptp,
      responderTimestampFormat: 0, responderPreferredFormat: 0, sessionId: 0x2abcdef, ds: 46, timestamps: [1n, 0n, 0n, 0n],
    });
    expect(bytes.length).toBe(44);
    expect(bytes[0]).toBe((PM_VERSION << 4) | 0x4);
    expect(bytes[4]).toBe(TimestampFormat.Ptp << 4);
    expect(decodeDelay(bytes)).toMatchObject({ sessionId: 0x2abcdef, ds: 46, response: false });
  });

  it('an LM response is 52 bytes with the X and B flags in DFlags and four 64-bit counters', () => {
    const bytes = encodeLoss({
      response: true, trafficClassSpecific: false, controlCode: ResponseControlCode.Success, extendedCounters: true, octetCounts: false,
      originTimestampFormat: TimestampFormat.Ptp, sessionId: 5, ds: 0, originTimestamp: 7n, counters: [1n, 2n, 3n, 4n],
    });
    expect(bytes.length).toBe(52);
    expect(bytes[0] & 0x8).toBe(0x8);
    expect(bytes[4] >> 4).toBe(0x8);
    expect(decodeLoss(bytes).counters).toEqual([1n, 2n, 3n, 4n]);
  });

  it('timestamps: PTP is 32-bit seconds plus 32-bit nanoseconds, NTP is the NTP 64-bit fixed point; both read back', () => {
    const ptp = encodeTimestamp(TimestampFormat.Ptp, 1500.25);
    expect(ptp >> 32n).toBe(1n);
    expect(decodeTimestamp(TimestampFormat.Ptp, ptp, 0)).toBeCloseTo(1500.25, 6);
    const ntp = encodeTimestamp(TimestampFormat.Ntp, 1500.25);
    expect(decodeTimestamp(TimestampFormat.Ntp, ntp, 1500)).toBeCloseTo(1500.25, 2);
  });
});

describe('delay measurement over the LSP pair (RFC 6374 §2.4, §4.3)', () => {
  it('measures a positive two-way delay equal to the wire time, with the responder echoing the format and a Success code', async () => {
    const { a } = await lab();
    const result = a.getTpPerformanceEngine().queryDelay({ outLsp: 'ac' });
    expect(result).toMatchObject({ responseCode: ResponseControlCode.Success, responderFormat: TimestampFormat.Ptp });
    expect(result!.roundTripMs!).toBeGreaterThan(0);
    expect(result!.roundTripMs!).toBeLessThan(5);
  });

  it('negotiates the timestamp format: NTP is answered in NTP, an unsupported format in the responder preferred one (PTP)', async () => {
    const { a } = await lab();
    const ntp = a.getTpPerformanceEngine().queryDelay({ outLsp: 'ac', timestampFormat: TimestampFormat.Ntp });
    expect(ntp).toMatchObject({ responderFormat: TimestampFormat.Ntp, responseCode: ResponseControlCode.Success });
    expect(ntp!.roundTripMs!).toBeGreaterThan(0);
    const odd = a.getTpPerformanceEngine().queryDelay({ outLsp: 'ac', timestampFormat: TimestampFormat.SequenceNumber });
    expect(odd).toMatchObject({ responderFormat: TimestampFormat.Ptp, responderPreferredFormat: TimestampFormat.Ptp });
    expect(odd!.roundTripMs).toBeNull();
  });

  it('the delay is symmetric: querying from either end of the pair gives the same wire time', async () => {
    const { a, c } = await lab();
    const long = a.getTpPerformanceEngine().queryDelay({ outLsp: 'ac' })!.roundTripMs!;
    const direct = c.getTpPerformanceEngine().queryDelay({ outLsp: 'ca' })!.roundTripMs!;
    expect(long).toBeGreaterThan(0);
    expect(Math.abs(long - direct)).toBeLessThan(1);
  });

  it('control code 2 (no response requested) gets no response; control code 1 (out-of-band) is refused in band with Unsupported Control Code', async () => {
    const { a } = await lab();
    expect(a.getTpPerformanceEngine().queryDelay({ outLsp: 'ac', controlCode: QueryControlCode.NoResponse })).toBeNull();
    expect(a.getTpPerformanceEngine().queryDelay({ outLsp: 'ac', controlCode: QueryControlCode.OutOfBandResponse }))
      .toMatchObject({ responseCode: ResponseControlCode.UnsupportedControlCode, roundTripMs: null });
  });
});

describe('direct loss measurement over the LSP pair (RFC 6374 §2.2, §4.2)', () => {
  it('WITNESS: with every packet delivered the loss is exactly 0 in both directions between two responses', async () => {
    const { a } = await lab();
    const engine = a.getTpPerformanceEngine();
    expect(engine.queryLoss({ outLsp: 'ac', sessionId: 1 })).toMatchObject({ forwardLoss: null, reverseLoss: null });
    for (let i = 0; i < 5; i++) a.getMplsTpEngine().sendClientPacket('ac', wireIp(i));
    const second = engine.queryLoss({ outLsp: 'ac', sessionId: 1 })!;
    expect(second).toMatchObject({ responseCode: ResponseControlCode.Success, forwardLoss: 0n, reverseLoss: 0n, unit: 'packets' });
  });

  it('packets dropped in the forward direction are counted as A-to-C loss only', async () => {
    const { a, b, c } = await lab();
    const engine = a.getTpPerformanceEngine();
    engine.queryLoss({ outLsp: 'ac', sessionId: 2 });
    for (let i = 0; i < 4; i++) a.getMplsTpEngine().sendClientPacket('ac', wireIp(i));
    b.getMplsEngine().lfib.removeIlm(MplsLabel.of(1001));
    for (let i = 0; i < 3; i++) a.getMplsTpEngine().sendClientPacket('ac', wireIp(10 + i));
    b.getMplsTpEngine().defineTransit({ inLabel: 1001, iface: 'GigabitEthernet0/1', nextHop: ip('10.2.0.3'), outLabel: 1002 });
    const result = engine.queryLoss({ outLsp: 'ac', sessionId: 2 })!;
    expect(result).toMatchObject({ forwardLoss: 3n, reverseLoss: 0n });
    expect(c.getMplsTpEngine().dataCounters('ac').rxPackets).toBe(4n);
  });

  it('packets sent in the reverse direction and dropped are counted as C-to-A loss only', async () => {
    const { a, b, c } = await lab();
    const engine = a.getTpPerformanceEngine();
    engine.queryLoss({ outLsp: 'ac', sessionId: 3 });
    b.getMplsEngine().lfib.removeIlm(MplsLabel.of(2001));
    for (let i = 0; i < 2; i++) c.getMplsTpEngine().sendClientPacket('ca', wireIp(20 + i));
    b.getMplsTpEngine().defineTransit({ inLabel: 2001, iface: 'GigabitEthernet0/0', nextHop: ip('10.1.0.1'), outLabel: 2002 });
    expect(engine.queryLoss({ outLsp: 'ac', sessionId: 3 })).toMatchObject({ forwardLoss: 0n, reverseLoss: 2n });
  });

  it('octet counts (B flag) count the packet lengths, and the G-ACh messages themselves are outside the scope', async () => {
    const { a } = await lab();
    const engine = a.getTpPerformanceEngine();
    engine.queryLoss({ outLsp: 'ac', sessionId: 4, octets: true });
    a.getMplsTpEngine().sendClientPacket('ac', wireIp(1));
    const result = engine.queryLoss({ outLsp: 'ac', sessionId: 4, octets: true })!;
    expect(result).toMatchObject({ unit: 'octets', forwardLoss: 0n });
    expect(a.getMplsTpEngine().dataCounters('ac').txOctets).toBe(BigInt(wireIp(1).totalLength));
    expect(a.getMplsTpEngine().dataCounters('ac').txPackets).toBe(1n);
  });

  it('a traffic-class-specific query is refused with Unsupported Data Format because no per-class counters exist', async () => {
    const { a } = await lab();
    expect(a.getTpPerformanceEngine().queryLoss({ outLsp: 'ac', trafficClassSpecific: true, ds: 46 }))
      .toMatchObject({ responseCode: ResponseControlCode.UnsupportedDataFormat, forwardLoss: null });
  });
});

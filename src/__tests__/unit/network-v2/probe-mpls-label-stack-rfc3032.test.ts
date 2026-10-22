/**
 * Probe: RFC 3032 label stack encoding and RFC 3443 TTL models
 * (docs/rfc/mpls/rfc3032.txt §2.1, §2.4; rfc3443.txt §3, figures in 3.1-3.3).
 * New subsystem: every case fails before (module absent), so the witnesses
 * are the end-to-end TTL walks that the RFC 3443 figures state numerically.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, computeIPv4Checksum, type IPv4Packet } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { decodeLabelStack, encodeLabelStack, makeLabelStackEntry } from '@/network/mpls/LabelStack';
import { Lfib } from '@/network/mpls/Lfib';
import { imposeLabels, switchLabelled } from '@/network/mpls/LabelSwitching';
import type { MplsPacket } from '@/network/mpls/MplsPacket';

function ipv4(ttl: number): IPv4Packet {
  const packet: IPv4Packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 84, identification: 1, flags: 0, fragmentOffset: 0,
    ttl, protocol: 1, headerChecksum: 0, sourceIP: new IPAddress('10.0.0.1'), destinationIP: new IPAddress('10.9.9.9'),
    payload: null as never,
  } as IPv4Packet;
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

describe('label value (RFC 3032 §2.1)', () => {
  it('accepts 0 to 2^20-1 and refuses the rest', () => {
    expect(MplsLabel.of(0).value).toBe(0);
    expect(MplsLabel.of(1048575).value).toBe(1048575);
    expect(() => MplsLabel.of(1048576)).toThrow(RangeError);
    expect(() => MplsLabel.of(-1)).toThrow(RangeError);
    expect(() => MplsLabel.of(1.5)).toThrow(RangeError);
    expect(MplsLabel.tryParse('1048576')).toBeNull();
    expect(MplsLabel.tryParse('abc')).toBeNull();
  });
  it('reserved values 0-3 and special purpose range', () => {
    expect(MplsLabel.IPV4_EXPLICIT_NULL.value).toBe(0);
    expect(MplsLabel.ROUTER_ALERT.value).toBe(1);
    expect(MplsLabel.IPV6_EXPLICIT_NULL.value).toBe(2);
    expect(MplsLabel.IMPLICIT_NULL.value).toBe(3);
    expect(MplsLabel.of(15).isSpecialPurpose()).toBe(true);
    expect(MplsLabel.of(16).isSpecialPurpose()).toBe(false);
  });
});

describe('encoding (RFC 3032 Figure 1)', () => {
  it('packs Label(20) Exp(3) S(1) TTL(8) in network order', () => {
    const bytes = encodeLabelStack([makeLabelStackEntry(MplsLabel.of(0x12345), 0xfe, 5)]);
    expect([...bytes]).toEqual([0x12, 0x34, 0x5b, 0xfe]);
  });
  it('sets S only on the last entry', () => {
    const bytes = encodeLabelStack([
      makeLabelStackEntry(MplsLabel.of(100), 64), makeLabelStackEntry(MplsLabel.of(200), 63), makeLabelStackEntry(MplsLabel.of(300), 62),
    ]);
    expect([bytes[2] & 1, bytes[6] & 1, bytes[10] & 1]).toEqual([0, 0, 1]);
  });
  it('round-trips and reports bytes consumed up to the S bit', () => {
    const stack = [makeLabelStackEntry(MplsLabel.of(17), 9, 3), makeLabelStackEntry(MplsLabel.of(1048575), 1, 7)];
    const encoded = encodeLabelStack(stack);
    const withTrailer = new Uint8Array([...encoded, 0x45, 0x00]);
    const decoded = decodeLabelStack(withTrailer)!;
    expect(decoded.consumed).toBe(8);
    expect(decoded.stack.map(e => [e.label.value, e.trafficClass, e.bottom, e.ttl])).toEqual([[17, 3, false, 9], [1048575, 7, true, 1]]);
  });
  it('refuses a stack with no bottom entry', () => {
    expect(decodeLabelStack(new Uint8Array([0, 6, 0x40, 64]))).toBeNull();
  });
  it('rejects out-of-range TTL and traffic class', () => {
    expect(() => makeLabelStackEntry(MplsLabel.of(20), 256)).toThrow(RangeError);
    expect(() => makeLabelStackEntry(MplsLabel.of(20), 10, 8)).toThrow(RangeError);
  });
});

function lsp(propagateTtl: boolean, php: boolean, hops: number) {
  const policy = { propagateTtl };
  const ingress = new Lfib();
  const ftn = { prefix: new IPAddress('10.9.0.0'), prefixLength: 16, outLabels: [MplsLabel.of(100)], iface: 'e0', nextHop: new IPAddress('1.1.1.2') };
  ingress.setFtn(ftn);
  let packet: MplsPacket | IPv4Packet = imposeLabels(ipv4(63), ftn, policy);
  const trace: number[] = [(packet as MplsPacket).stack[0].ttl];
  for (let hop = 0; hop < hops; hop++) {
    const lfib = new Lfib();
    const last = hop === hops - 1;
    lfib.setIlm(MplsLabel.of(100 + hop), last
      ? (php ? { kind: 'pop', iface: 'e0', nextHop: new IPAddress('1.1.1.2') } : { kind: 'pop', iface: null, nextHop: null })
      : { kind: 'swap', outLabels: [MplsLabel.of(101 + hop)], iface: 'e0', nextHop: new IPAddress('1.1.1.2') });
    const decision = switchLabelled(packet as MplsPacket, lfib, policy);
    if (decision.kind === 'labelled') { packet = decision.packet; trace.push(decision.packet.stack[0].ttl); }
    else if (decision.kind === 'unlabelled' || decision.kind === 'deliver') { trace.push(decision.packet.ttl); return { trace, decision }; }
    else throw new Error(decision.kind);
  }
  throw new Error('no end');
}

describe('TTL (RFC 3032 §2.4, RFC 3443 §3.1 uniform model)', () => {
  it('label TTL is copied from the IP TTL at imposition', () => {
    const ftn = { prefix: new IPAddress('10.9.0.0'), prefixLength: 16, outLabels: [MplsLabel.of(100)], iface: 'e0', nextHop: new IPAddress('1.1.1.2') };
    expect(imposeLabels(ipv4(63), ftn, { propagateTtl: true }).stack[0].ttl).toBe(63);
    expect(imposeLabels(ipv4(63), ftn, { propagateTtl: false }).stack[0].ttl).toBe(255);
  });
  it('swap decrements by one; PHP exposes IP with the outgoing TTL', () => {
    const { trace, decision } = lsp(true, true, 3);
    expect(trace).toEqual([63, 62, 61, 60]);
    expect(decision.kind).toBe('unlabelled');
  });
  it('pop without PHP delivers with the TTL accounted', () => {
    const { decision } = lsp(true, false, 3);
    expect(decision).toMatchObject({ kind: 'deliver', ttlAccounted: true });
    expect((decision as { packet: IPv4Packet }).packet.ttl).toBe(60);
  });
  it('short pipe: IP TTL is untouched by the LSP (RFC 3443 §3.2.2 remark 3)', () => {
    const { decision } = lsp(false, true, 3);
    expect(decision.kind).toBe('unlabelled');
    expect((decision as { packet: IPv4Packet }).packet.ttl).toBe(63);
  });
  it('a label TTL of 1 expires: it is neither forwarded nor stripped (§2.4.2)', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), { kind: 'pop', iface: 'e0', nextHop: new IPAddress('1.1.1.2') });
    const packet: MplsPacket = { type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.of(100), 1, 0, true)], payload: ipv4(5) };
    expect(switchLabelled(packet, lfib, { propagateTtl: true }).kind).toBe('expired');
    expect(switchLabelled({ ...packet, stack: [makeLabelStackEntry(MplsLabel.of(100), 0, 0, true)] }, lfib, { propagateTtl: true }).kind).toBe('expired');
  });
});

describe('switching', () => {
  it('unknown incoming label has no binding', () => {
    const packet: MplsPacket = { type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.of(999), 9, 0, true)], payload: ipv4(5) };
    expect(switchLabelled(packet, new Lfib(), { propagateTtl: true }).kind).toBe('no-binding');
  });
  it('explicit null at the bottom pops and delivers to IP (§2.1 i)', () => {
    const packet: MplsPacket = { type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.IPV4_EXPLICIT_NULL, 9, 0, true)], payload: ipv4(9) };
    const decision = switchLabelled(packet, new Lfib(), { propagateTtl: true });
    expect(decision).toMatchObject({ kind: 'deliver' });
    expect((decision as { packet: IPv4Packet }).packet.ttl).toBe(8);
  });
  it('swap+push builds a two-level stack, inner carries oTTL', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), { kind: 'swap', outLabels: [MplsLabel.of(500), MplsLabel.of(200)], iface: 'e0', nextHop: new IPAddress('1.1.1.2') });
    const packet: MplsPacket = { type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.of(100), 20, 2, true)], payload: ipv4(5) };
    const decision = switchLabelled(packet, lfib, { propagateTtl: true });
    if (decision.kind !== 'labelled') throw new Error(decision.kind);
    expect(decision.packet.stack.map(e => [e.label.value, e.ttl, e.bottom])).toEqual([[500, 19, false], [200, 19, true]]);
  });
  it('lfib: longest-prefix FTN, label reuse after release', () => {
    const lfib = new Lfib();
    const base = { iface: 'e0', nextHop: new IPAddress('1.1.1.2') };
    lfib.setFtn({ prefix: new IPAddress('10.0.0.0'), prefixLength: 8, outLabels: [MplsLabel.of(30)], ...base });
    lfib.setFtn({ prefix: new IPAddress('10.9.0.0'), prefixLength: 16, outLabels: [MplsLabel.of(31)], ...base });
    expect(lfib.lookupFtn(new IPAddress('10.9.1.1'))!.outLabels[0].value).toBe(31);
    expect(lfib.lookupFtn(new IPAddress('10.8.1.1'))!.outLabels[0].value).toBe(30);
    expect(lfib.lookupFtn(new IPAddress('11.0.0.1'))).toBeUndefined();
    const first = lfib.allocateLabel();
    expect(first.value).toBe(16);
    lfib.releaseLabel(first);
    expect(lfib.allocateLabel().value).toBe(16);
  });
});

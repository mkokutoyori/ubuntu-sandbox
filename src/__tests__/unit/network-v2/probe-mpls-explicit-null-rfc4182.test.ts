/**
 * Probe: Explicit NULL anywhere in the stack (docs/rfc/mpls/rfc4182.txt §2,
 * replacing paragraphs i and iii of RFC 3032 §2.1).
 * Before: an Explicit NULL above another label was refused (no-binding), so the
 * Pipe Model packet [explicit-null, transport label] was dropped.
 * 3 of 4 cases fail before; the witness (explicit null as the only label still
 * pops and delivers to IP) passes either way and proves the lab.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, computeIPv4Checksum, type IPv4Packet } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { makeLabelStackEntry } from '@/network/mpls/LabelStack';
import { Lfib } from '@/network/mpls/Lfib';
import { switchLabelled } from '@/network/mpls/LabelSwitching';
import type { MplsPacket } from '@/network/mpls/MplsPacket';

function ipv4(ttl: number): IPv4Packet {
  const packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 84, identification: 1, flags: 0, fragmentOffset: 0,
    ttl, protocol: 1, headerChecksum: 0, sourceIP: new IPAddress('10.0.0.1'), destinationIP: new IPAddress('10.9.9.9'),
    payload: null,
  } as unknown as IPv4Packet;
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

const swapTo = (label: number) => ({
  kind: 'swap' as const, outLabels: [MplsLabel.of(label)], iface: 'g1', nextHop: new IPAddress('10.0.0.2'),
});

describe('Explicit NULL above another label (RFC 4182 §2)', () => {
  it('pops and switches on the label that rose to the top', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), swapTo(200));
    const packet: MplsPacket = {
      type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.IPV4_EXPLICIT_NULL, 9), makeLabelStackEntry(MplsLabel.of(100), 9, 0, true)],
      payload: ipv4(9),
    };
    const decision = switchLabelled(packet, lfib, { propagateTtl: false });
    expect(decision.kind).toBe('labelled');
    if (decision.kind !== 'labelled') return;
    expect(decision.packet.stack.map(entry => entry.label.value)).toEqual([200]);
  });

  it('the TTL is decremented once for the packet, not once per entry', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), swapTo(200));
    const packet: MplsPacket = {
      type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.IPV6_EXPLICIT_NULL, 9), makeLabelStackEntry(MplsLabel.of(100), 9, 0, true)],
      payload: ipv4(9),
    };
    const decision = switchLabelled(packet, lfib, { propagateTtl: true });
    expect(decision.kind === 'labelled' && decision.packet.stack[0].ttl).toBe(8);
  });

  it('delivers to the IP header when the label below is itself an Explicit NULL at the bottom', () => {
    const packet: MplsPacket = {
      type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.IPV4_EXPLICIT_NULL, 9), makeLabelStackEntry(MplsLabel.IPV4_EXPLICIT_NULL, 9, 0, true)],
      payload: ipv4(9),
    };
    expect(switchLabelled(packet, new Lfib(), { propagateTtl: false }).kind).toBe('deliver');
  });

  it('WITNESS: an Explicit NULL as the only label pops and delivers to IP (RFC 3032 §2.1 i)', () => {
    const packet: MplsPacket = {
      type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.IPV4_EXPLICIT_NULL, 9, 0, true)], payload: ipv4(9),
    };
    expect(switchLabelled(packet, new Lfib(), { propagateTtl: false }).kind).toBe('deliver');
  });
});

/**
 * Probe: Diff-Serv information carried in the MPLS Traffic Class field
 * (docs/rfc/mpls/rfc3270.txt §2.6 tunnelling models, §3.2.1 default mapping).
 * R1 (ingress) - R2 (penultimate, pops) - R3 (egress). Without a configured mapping
 * every Traffic Class stays 0 (the RFC's default: all values map to the Default PHB).
 * Pipe (the default model): the pushed labels carry the tunnel's own class and the
 * pop leaves the exposed header as it is. Uniform: the class is derived from the
 * incoming DSCP, carried unchanged by swaps, and written back into the DSCP (or the
 * next label) at the pop. The probe drives the data plane functions on real
 * packets; the wire lab shows the stack seen by the transit LSR.
 * All 7 cases fail before (no model, no mapping API); the witness (no mapping
 * configured leaves class 0) proves that the default is the RFC's, not an accident.
 */
import { describe, it, expect } from 'vitest';
import { IPAddress, IP_PROTO_ICMP, createIPv4Packet, type IPv4Packet } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { makeLabelStackEntry } from '@/network/mpls/LabelStack';
import { Lfib } from '@/network/mpls/Lfib';
import { MplsEngine } from '@/network/mpls/MplsEngine';
import { switchLabelled } from '@/network/mpls/LabelSwitching';
import type { MplsPacket } from '@/network/mpls/MplsPacket';

const host = {
  sendLabelled: () => undefined, sendUnlabelled: () => undefined, continueAsIp: () => undefined,
  continueInVrf: () => undefined, expired: () => undefined, echoRequest: () => undefined, deliverPseudowire: () => undefined, deliverGach: () => undefined, deliverTransport: () => undefined,
};

function engine(): MplsEngine {
  const mpls = new MplsEngine(host);
  mpls.enableInterface('g1');
  mpls.lfib.setFtn({
    prefix: new IPAddress('10.9.9.0'), prefixLength: 24, outLabels: [MplsLabel.of(100)], iface: 'g1', nextHop: new IPAddress('10.0.0.2'),
  });
  return mpls;
}

function packet(dscp: number): IPv4Packet {
  return createIPv4Packet(new IPAddress('10.0.0.1'), new IPAddress('10.9.9.9'), IP_PROTO_ICMP, 60,
    { type: 'icmp', icmpType: 'echo-request', code: 0, id: 1, sequence: 1, dataSize: 8 }, 16, { tos: dscp << 2 | 1 });
}

describe('imposition', () => {
  it('WITNESS: with no mapping configured every pushed label carries class 0', () => {
    const mpls = engine();
    mpls.diffServModel = 'uniform';
    expect(mpls.impose(packet(46), 'g1', new IPAddress('10.0.0.2'))!.stack[0].trafficClass).toBe(0);
  });

  it('uniform: the class is the mapping of the incoming DSCP', () => {
    const mpls = engine();
    mpls.diffServModel = 'uniform';
    mpls.mapDscp(46, 5);
    expect(mpls.impose(packet(46), 'g1', new IPAddress('10.0.0.2'))!.stack[0].trafficClass).toBe(5);
    expect(mpls.impose(packet(10), 'g1', new IPAddress('10.0.0.2'))!.stack[0].trafficClass).toBe(0);
  });

  it('pipe: the class is the tunnel class whatever the tunnelled DSCP, and the inner DSCP is untouched', () => {
    const mpls = engine();
    mpls.diffServModel = 'pipe';
    mpls.tunnelTrafficClass = 3;
    mpls.mapDscp(46, 5);
    const labelled = mpls.impose(packet(46), 'g1', new IPAddress('10.0.0.2'))!;
    expect(labelled.stack[0].trafficClass).toBe(3);
    expect((labelled.payload as IPv4Packet).tos >> 2).toBe(46);
  });
});

describe('swap and pop', () => {
  function stackOf(...classes: number[]): MplsPacket {
    return {
      type: 'mpls',
      stack: classes.map((trafficClass, index) => makeLabelStackEntry(MplsLabel.of(100 + index), 60, trafficClass, index === classes.length - 1)),
      payload: packet(0),
    };
  }

  it('a swap carries the class unchanged', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), { kind: 'swap', outLabels: [MplsLabel.of(200)], iface: 'g1', nextHop: new IPAddress('10.0.0.2') });
    const decision = switchLabelled(stackOf(5), lfib, { propagateTtl: false });
    expect(decision.kind === 'labelled' && decision.packet.stack[0].trafficClass).toBe(5);
  });

  it('uniform pop to IP: the DSCP is rewritten from the class of the popped label, the ECN bits are kept', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), { kind: 'pop', iface: 'g2', nextHop: new IPAddress('10.1.0.2') });
    const mpls = new MplsEngine(host);
    mpls.diffServModel = 'uniform';
    mpls.mapTrafficClass(5, 46);
    const decision = switchLabelled(stackOf(5), lfib, mpls);
    expect(decision.kind).toBe('unlabelled');
    const exposed = decision.kind === 'unlabelled' ? decision.packet : null;
    expect(exposed!.tos).toBe((46 << 2) | 1);
  });

  it('pipe pop to IP: the exposed DSCP is left as it is', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), { kind: 'pop', iface: 'g2', nextHop: new IPAddress('10.1.0.2') });
    const mpls = new MplsEngine(host);
    mpls.diffServModel = 'pipe';
    mpls.mapTrafficClass(5, 46);
    const original = stackOf(5).payload as IPv4Packet;
    const decision = switchLabelled(stackOf(5), lfib, mpls);
    expect(decision.kind === 'unlabelled' && decision.packet.tos).toBe(original.tos);
  });

  it('uniform pop to a label below: the class moves to the exposed label; pipe leaves it', () => {
    const lfib = new Lfib();
    lfib.setIlm(MplsLabel.of(100), { kind: 'pop', iface: 'g2', nextHop: new IPAddress('10.1.0.2') });
    const uniform = new MplsEngine(host);
    uniform.diffServModel = 'uniform';
    const pipe = new MplsEngine(host);
    pipe.diffServModel = 'pipe';
    const uniformDecision = switchLabelled(stackOf(6, 1), lfib, uniform);
    const pipeDecision = switchLabelled(stackOf(6, 1), lfib, pipe);
    expect(uniformDecision.kind === 'labelled' && uniformDecision.packet.stack[0].trafficClass).toBe(6);
    expect(pipeDecision.kind === 'labelled' && pipeDecision.packet.stack[0].trafficClass).toBe(1);
  });
});

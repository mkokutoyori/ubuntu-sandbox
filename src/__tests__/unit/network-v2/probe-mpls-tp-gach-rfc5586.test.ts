/**
 * Probe: the MPLS-TP generic associated channel over static LSPs
 * (docs/rfc/mpls/rfc5586.txt §2, §4; rfc5960.txt §3.1, §3.2, §4).
 * A - B - C with a statically provisioned bidirectional co-routed LSP (no LDP, no PHP:
 * the egress receives its own LSP label). An OAM message is an ACH-led payload below
 * the GAL (label 13, S=1, TTL >= 1) at the bottom of the stack. A transit LSR swaps the
 * LSP label and never looks at the GAL; the LSP egress pops its label and finds the GAL;
 * on a section the GAL alone is the stack; a TTL that expires at a transit LSR sends
 * the packet to its control plane (the only other place the GAL is inspected).
 * New: all 8 cases fail before (no GAL handling, no static LSP, no G-ACh payload).
 * Witness: the same message with TTL 255 reaches C, so the expiry case is the TTL.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, computeIPv4Checksum, type IPv4Packet } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { makeLabelStackEntry } from '@/network/mpls/LabelStack';
import { Lfib } from '@/network/mpls/Lfib';
import { switchLabelled } from '@/network/mpls/LabelSwitching';
import { ChannelType, achWord, channelTypeOfAch, type GachPayload } from '@/network/mpls/tp/GachPacket';
import type { GachDelivery } from '@/network/mpls/MplsEngine';
import type { MplsPacket } from '@/network/mpls/MplsPacket';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

const ip = (text: string) => new IPAddress(text);
const oam = (channelType: number, body: string): GachPayload => ({ type: 'gach', channelType, message: body });

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
  const seen = { a: [] as GachDelivery[], b: [] as GachDelivery[], c: [] as GachDelivery[] };
  for (const [name, router] of [['a', a], ['b', b], ['c', c]] as const) {
    router.getMplsTpEngine().registerChannel(ChannelType.BfdContinuityCheck, delivery => seen[name].push(delivery));
  }
  return { a, b, c, seen };
}

function recordStacks(router: CiscoRouter): number[][] {
  const stacks: number[][] = [];
  const engine = router.getMplsEngine();
  const original = engine.receive.bind(engine);
  engine.receive = (inPort, packet) => { stacks.push(packet.stack.map(entry => entry.label.value)); original(inPort, packet); };
  return stacks;
}

describe('the ACH (RFC 5586 §2.1)', () => {
  it('has first nibble 1, version 0, reserved 0 and the channel type in the low 16 bits', () => {
    expect(achWord(ChannelType.BfdContinuityCheck)).toBe(0x10000022);
    expect(channelTypeOfAch(0x10000022)).toBe(0x0022);
    expect(channelTypeOfAch(0x00000022)).toBeNull();
  });
});

describe('G-ACh messages over a static LSP (RFC 5960 §3.1, RFC 5586 §4)', () => {
  it('A reaches the LSP egress C through the transit B: B swaps and never sees the GAL, C finds it under its own label (no PHP)', async () => {
    const { a, b, c, seen } = await lab();
    const atB = recordStacks(b);
    const atC = recordStacks(c);
    expect(a.getMplsTpEngine().sendOverLsp('ac', oam(ChannelType.BfdContinuityCheck, 'hello'))).toBe(true);
    expect(atB).toEqual([[1001, 13]]);
    expect(atC).toEqual([[1002, 13]]);
    expect(seen.c).toHaveLength(1);
    expect(seen.c[0]).toMatchObject({ lsp: 'ac', reason: 'terminated', payload: { channelType: 0x0022, message: 'hello' } });
    expect(seen.b).toHaveLength(0);
  });

  it('the return direction is a separate unidirectional LSP of the pair', async () => {
    const { c, seen } = await lab();
    c.getMplsTpEngine().sendOverLsp('ca', oam(ChannelType.BfdContinuityCheck, 'reply'));
    expect(seen.a).toHaveLength(1);
    expect(seen.a[0]).toMatchObject({ lsp: 'ca', reason: 'terminated' });
  });

  it('on a section the GAL alone is the stack and the neighbour receives the message without any LSP', async () => {
    const { a, b, seen } = await lab();
    b.getMplsTpEngine().enableSection('GigabitEthernet0/0');
    a.getMplsTpEngine().enableSection('GigabitEthernet0/0');
    a.getMplsTpEngine().sendOverSection('GigabitEthernet0/0', ip('10.1.0.2'), oam(ChannelType.BfdContinuityCheck, 'section'));
    expect(seen.b).toHaveLength(1);
    expect(seen.b[0]).toMatchObject({ lsp: null, reason: 'terminated', payload: { message: 'section' } });
  });

  it('a TTL that expires at the transit LSR sends the packet to its control plane and it is not forwarded', async () => {
    const { a, seen } = await lab();
    a.getMplsTpEngine().sendOverLsp('ac', oam(ChannelType.BfdContinuityCheck, 'probe'), 1);
    expect(seen.b).toHaveLength(1);
    expect(seen.b[0]).toMatchObject({ reason: 'ttl-expired', payload: { message: 'probe' } });
    expect(seen.c).toHaveLength(0);
  });

  it('WITNESS: with TTL 255 the same message crosses B and reaches C, so the expiry is the TTL', async () => {
    const { a, seen } = await lab();
    a.getMplsTpEngine().sendOverLsp('ac', oam(ChannelType.BfdContinuityCheck, 'probe'), 255);
    expect(seen.b).toHaveLength(0);
    expect(seen.c).toHaveLength(1);
  });

  it('a channel type nobody registered is counted and dropped', async () => {
    const { a, c, seen } = await lab();
    a.getMplsTpEngine().sendOverLsp('ac', oam(ChannelType.DelayMeasurement, 'nobody'));
    expect(seen.c).toHaveLength(0);
    expect(c.getMplsTpEngine().counters.unhandled).toBe(1);
  });
});

describe('the GAL is only honoured where RFC 5586 allows it', () => {
  const dummyIp = (): IPv4Packet => {
    const packet = {
      type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 84, identification: 1, flags: 0, fragmentOffset: 0, ttl: 9, protocol: 1,
      headerChecksum: 0, sourceIP: ip('10.0.0.1'), destinationIP: ip('10.9.9.9'), payload: null,
    } as unknown as IPv4Packet;
    packet.headerChecksum = computeIPv4Checksum(packet);
    return packet;
  };

  it('a GAL that is not at the bottom of the stack, or over an IP payload, is dropped', () => {
    const lfib = new Lfib();
    const notBottom: MplsPacket = {
      type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.GENERIC_ASSOCIATED_CHANNEL, 5), makeLabelStackEntry(MplsLabel.of(50), 5, 0, true)],
      payload: oam(ChannelType.BfdContinuityCheck, 'x'),
    };
    const overIp: MplsPacket = {
      type: 'mpls', stack: [makeLabelStackEntry(MplsLabel.GENERIC_ASSOCIATED_CHANNEL, 5, 0, true)], payload: dummyIp(),
    };
    expect(switchLabelled(notBottom, lfib, { propagateTtl: false }).kind).toBe('no-binding');
    expect(switchLabelled(overIp, lfib, { propagateTtl: false }).kind).toBe('no-binding');
  });
});

/**
 * Probe: MPLS entropy labels (docs/rfc/mpls/rfc6790.txt §3, §4.1, §4.2, §4.3, §5.1).
 * CE1 - R1 - R2 - R3 - CE2 with LDP. R3 is the egress of 192.168.2.0/24 and signals
 * the Entropy Label Capability TLV (0x0206, U=F=1) in its Label Mapping; R2 propagates
 * it only if every mapping it received carries it (§5.1.1); R1 then pushes
 * <TL, ELI, EL> (ELI 7 with TL's TTL and BoS 0, EL >= 16 with TTL 0); R2 swaps only
 * the tunnel label; the egress pops ELI and EL. New subsystem: all 9 cases fail before.
 * Witnesses: with imposition off the stack is <TL> only and the ping works; with a
 * non-capable transit the ingress does not impose (§4.2 note c).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, computeIPv4Checksum, type IPv4Packet } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { makeLabelStackEntry } from '@/network/mpls/LabelStack';
import { Lfib } from '@/network/mpls/Lfib';
import { switchLabelled } from '@/network/mpls/LabelSwitching';
import { entropyLabelFor } from '@/network/mpls/MplsEngine';
import type { MplsPacket } from '@/network/mpls/MplsPacket';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { decodePdu, encodePdu } from '@/network/ldp/LdpCodec';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

async function whileTimePasses<T>(work: Promise<T>): Promise<T> {
  let done = false;
  void work.finally(() => { done = true; });
  while (!done) {
    clock.advance(100);
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  return work;
}

async function lab(options: { r2Capable?: boolean; impose?: boolean } = {}) {
  const ce1 = new LinuxPC('linux-pc', 'CE1');
  const ce2 = new LinuxPC('linux-pc', 'CE2');
  const [r1, r2, r3] = [new CiscoRouter('R1'), new CiscoRouter('R2'), new CiscoRouter('R3')];
  new Cable('a').connect(ce1.getPort('eth0')!, r1.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);
  new Cable('d').connect(r3.getPort('GigabitEthernet0/1')!, ce2.getPort('eth0')!);
  await run(r1, ['interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 192.168.1.1 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.2.0 255.255.255.0 10.12.0.2', 'ip route 10.23.0.0 255.255.255.0 10.12.0.2',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2', 'ip route 3.3.3.3 255.255.255.255 10.12.0.2']);
  await run(r2, ['interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.23.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.2.0 255.255.255.0 10.23.0.3', 'ip route 192.168.1.0 255.255.255.0 10.12.0.1',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1', 'ip route 3.3.3.3 255.255.255.255 10.23.0.3']);
  await run(r3, ['interface Loopback0', 'ip address 3.3.3.3 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.23.0.3 255.255.255.0', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 192.168.2.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 192.168.1.0 255.255.255.0 10.23.0.2', 'ip route 10.12.0.0 255.255.255.0 10.23.0.2',
    'ip route 1.1.1.1 255.255.255.255 10.23.0.2', 'ip route 2.2.2.2 255.255.255.255 10.23.0.2']);
  await ce1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await ce1.executeCommand('sudo ip route add default via 192.168.1.1');
  await ce2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await ce2.executeCommand('sudo ip route add default via 192.168.2.1');
  for (const [router, iface] of [[r1, 'GigabitEthernet0/1'], [r2, 'GigabitEthernet0/0'], [r2, 'GigabitEthernet0/1'], [r3, 'GigabitEthernet0/0']] as const) {
    router.getLdpEngine().enableInterface(iface);
  }
  clock.advance(6000);
  r3.getLdpEngine().setEntropyLabelCapable(true);
  if (options.r2Capable !== false) r2.getLdpEngine().setEntropyLabelCapable(true);
  r1.getLdpEngine().setEntropyLabelCapable(true);
  r1.getMplsEngine().imposeEntropyLabels = options.impose !== false;
  clock.advance(20000);
  return { ce1, r1, r2, r3 };
}

function recordStacks(router: CiscoRouter): number[][] {
  const stacks: number[][] = [];
  const engine = router.getMplsEngine();
  const original = engine.receive.bind(engine);
  engine.receive = (inPort, packet) => { stacks.push(packet.stack.map(entry => entry.label.value)); original(inPort, packet); };
  return stacks;
}

function ip(ttl = 9): IPv4Packet {
  const packet = {
    type: 'ipv4', version: 4, ihl: 5, tos: 0, totalLength: 84, identification: 1, flags: 0, fragmentOffset: 0,
    ttl, protocol: 1, headerChecksum: 0, sourceIP: new IPAddress('10.0.0.1'), destinationIP: new IPAddress('10.9.9.9'), payload: null,
  } as unknown as IPv4Packet;
  packet.headerChecksum = computeIPv4Checksum(packet);
  return packet;
}

describe('Entropy Label Capability TLV (§5.1)', () => {
  it('is encoded with U=1, F=1, type 0x0206, length 0 and round-trips', () => {
    const sender = LdpIdentifier.of(new IPAddress('1.1.1.1'), 0);
    const bytes = encodePdu({ version: 1, sender, messages: [{
      kind: 'label-mapping', id: 1, fec: [{ kind: 'prefix', prefix: new IPAddress('3.3.3.3'), length: 32 }], label: MplsLabel.of(30),
      entropyLabelCapable: true,
    }] });
    const text = Array.from(bytes);
    const at = text.findIndex((value, index) => value === 0xc2 && text[index + 1] === 0x06 && text[index + 2] === 0 && text[index + 3] === 0);
    expect(at).toBeGreaterThan(0);
    expect(decodePdu(bytes).messages[0]).toMatchObject({ kind: 'label-mapping', entropyLabelCapable: true });
  });

  it('the ingress learns that the whole path is capable when the egress and the transit all signal it', async () => {
    const { r1 } = await lab();
    const entry = r1.getMplsEngine().lfib.ftnEntries().find(e => String(e.prefix) === '192.168.2.0');
    expect(entry?.entropyLabelCapable).toBe(true);
  });

  it('WITNESS: a transit that does not understand the capability does not propagate it, so the ingress learns none (§5.1.1)', async () => {
    const { r1 } = await lab({ r2Capable: false });
    const entry = r1.getMplsEngine().lfib.ftnEntries().find(e => String(e.prefix) === '192.168.2.0');
    expect(entry).toBeDefined();
    expect(entry?.entropyLabelCapable).not.toBe(true);
  });
});

describe('forwarding with <TL, ELI, EL> (§4)', () => {
  it('the ingress pushes ELI (7) and an EL (>= 16, TTL 0) above the application traffic; the transit sees three labels; the egress pops ELI and EL; the ping works', async () => {
    const { ce1, r2, r3 } = await lab();
    const atR2 = recordStacks(r2);
    const atR3 = recordStacks(r3);
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.2.10'));
    expect(out).toContain('2 received');
    const forward = atR2.find(stack => stack.length === 2 && stack[0] >= 16 && stack[1] === 7);
    expect(forward).toBeUndefined();
    const withEntropy = atR2.find(stack => stack.length === 3);
    expect(withEntropy?.[1]).toBe(7);
    expect(withEntropy?.[2]).toBeGreaterThanOrEqual(16);
    expect(atR3.find(stack => stack.length === 2 && stack[0] === 7)).toBeDefined();
  });

  it('WITNESS: with imposition off the stack is the tunnel label only and the ping works', async () => {
    const { ce1, r2 } = await lab({ impose: false });
    const atR2 = recordStacks(r2);
    const out = await whileTimePasses(ce1.executeCommand('ping -c 2 -W 1 192.168.2.10'));
    expect(out).toContain('2 received');
    expect(atR2.some(stack => stack.length === 1)).toBe(true);
    expect(atR2.some(stack => stack.length > 1)).toBe(false);
  });

  it('the entropy label is a function of the flow: same flow, same label; at least 16', () => {
    const a = entropyLabelFor('10.0.0.1|10.0.0.2|6|1000|80');
    expect(entropyLabelFor('10.0.0.1|10.0.0.2|6|1000|80').equals(a)).toBe(true);
    expect(entropyLabelFor('10.0.0.1|10.0.0.2|6|1001|80').equals(a)).toBe(false);
    expect(a.value).toBeGreaterThanOrEqual(16);
  });
});

describe('processing the ELI (§4.1, §4.3)', () => {
  const policy = (entropyLabelCapable: boolean) => ({ propagateTtl: false, entropyLabelCapable });
  const eliStack = (eliBottom: boolean): MplsPacket => ({
    type: 'mpls',
    stack: eliBottom
      ? [makeLabelStackEntry(MplsLabel.ENTROPY_LABEL_INDICATOR, 9, 0, true)]
      : [makeLabelStackEntry(MplsLabel.ENTROPY_LABEL_INDICATOR, 9), makeLabelStackEntry(MplsLabel.of(50), 0, 0, true)],
    payload: ip(),
  });

  it('a capable egress pops the ELI and the EL even though the EL has TTL 0, and delivers the IP packet', () => {
    expect(switchLabelled(eliStack(false), new Lfib(), policy(true)).kind).toBe('deliver');
  });

  it('an ELI with the BoS bit set is discarded (§4.1)', () => {
    expect(switchLabelled(eliStack(true), new Lfib(), policy(true)).kind).toBe('no-binding');
  });

  it('any other LSR drops a packet whose top label is the ELI (§4.3)', () => {
    expect(switchLabelled(eliStack(false), new Lfib(), policy(false)).kind).toBe('no-binding');
  });
});

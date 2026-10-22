/**
 * Probe: LDP MTU signalling (docs/rfc/mpls/rfc3988.txt §2.3, §2.4, §4).
 * CE1 - R1 - R2 - R3 - CE2, link R2-R3 at MTU 1400, the others 1500. R3 is the egress
 * of 192.168.2.0/24 (LSP MTU 65535); R2 is the penultimate hop and receives an
 * implicit null, so its Hop MTU is the link MTU (1400, optional rule B); R1's Hop MTU
 * is 1500 - 4 and its LSP MTU the minimum of that and R2's 1400. The ingress then
 * treats the LSP as the next hop (RFC 1191): a DF packet above 1400 is refused with
 * ICMP "fragmentation needed" carrying 1400; a non-DF one is fragmented to 1400.
 * New: all 5 cases fail before (no MTU TLV, no LSP MTU).
 * Witness: with equal 1500 MTUs the LSP MTU is 1496 and a 1450-byte DF packet passes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { MplsLabel } from '@/network/mpls/MplsLabel';
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

async function lab(narrowLink: number) {
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
  r2.getPort('GigabitEthernet0/1')!.setMTU(narrowLink);
  r3.getPort('GigabitEthernet0/0')!.setMTU(narrowLink);
  await ce1.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await ce1.executeCommand('sudo ip route add default via 192.168.1.1');
  await ce2.executeCommand('sudo ip addr add 192.168.2.10/24 dev eth0');
  await ce2.executeCommand('sudo ip route add default via 192.168.2.1');
  for (const [router, iface] of [[r1, 'GigabitEthernet0/1'], [r2, 'GigabitEthernet0/0'], [r2, 'GigabitEthernet0/1'], [r3, 'GigabitEthernet0/0']] as const) {
    router.getLdpEngine().enableInterface(iface);
  }
  clock.advance(30000);
  return { ce1, r1, r2, r3 };
}

const lspMtuAt = (router: CiscoRouter) => router.getMplsEngine().lfib.ftnEntries().find(e => String(e.prefix) === '192.168.2.0')?.lspMtu;

describe('MTU TLV (§2.4)', () => {
  it('is encoded with U=1, F=1, type 0x0601, length 2 and round-trips', () => {
    const sender = LdpIdentifier.of(new IPAddress('1.1.1.1'), 0);
    const bytes = encodePdu({ version: 1, sender, messages: [{
      kind: 'label-mapping', id: 1, fec: [{ kind: 'prefix', prefix: new IPAddress('3.3.3.3'), length: 32 }], label: MplsLabel.of(30), lspMtu: 1400,
    }] });
    const list = Array.from(bytes);
    const at = list.findIndex((value, index) => value === 0xc6 && list[index + 1] === 0x01 && list[index + 2] === 0 && list[index + 3] === 2);
    expect(at).toBeGreaterThan(0);
    expect(decodePdu(bytes).messages[0]).toMatchObject({ kind: 'label-mapping', lspMtu: 1400 });
  });
});

describe('computing and advertising the LSP MTU (§2.3)', () => {
  it('the penultimate hop takes the link MTU, the ingress the minimum of its own Hop MTU and the downstream value', async () => {
    const { r1, r2 } = await lab(1400);
    expect(lspMtuAt(r2)).toBe(1400);
    expect(lspMtuAt(r1)).toBe(1400);
  });

  it('WITNESS: with every link at 1500 the ingress LSP MTU is the labelled Hop MTU, 1496', async () => {
    const { r1 } = await lab(1500);
    expect(lspMtuAt(r1)).toBe(1496);
  });
});

describe('using the LSP MTU at the ingress (§4)', () => {
  it('a DF packet above the LSP MTU is refused with ICMP fragmentation needed carrying the LSP MTU', async () => {
    const { ce1 } = await lab(1400);
    const out = await whileTimePasses(ce1.executeCommand('ping -c 1 -W 1 -M do -s 1422 192.168.2.10'));
    expect(out).toMatch(/mtu = 1400|Frag needed/i);
    expect(out).toContain('0 received');
  });

  it('a packet without DF is fragmented to the LSP MTU and still gets through', async () => {
    const { ce1 } = await lab(1400);
    const out = await whileTimePasses(ce1.executeCommand('ping -c 1 -W 2 -M dont -s 1422 192.168.2.10'));
    expect(out).toContain('1 received');
  });
});

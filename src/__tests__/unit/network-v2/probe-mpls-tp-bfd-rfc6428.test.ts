/**
 * Probe: MPLS-TP BFD continuity check, connectivity verification and RDI
 * (docs/rfc/mpls/rfc6428.txt §3.2-§3.7) over the static LSP pair A - B - C.
 * CC (code point 0x0022) carries the BFD control packet; every second a CV
 * (0x0023) carries it followed by the Source MEP-ID TLV (LSP MEP-ID: global id,
 * node id, tunnel and LSP numbers). Only CC packets drive the state machine
 * (the BFD one from bfd/types, shared with the IP agent); detection time is the
 * interval times 3; a sink MEP that detects a loss encodes diagnostic 1, one that
 * detects mis-connectivity encodes 9, and the far end learns of it from the
 * diagnostic of the DOWN it receives (RDI).
 * New: all 8 cases fail before (no TP BFD engine, no diagnostic 9).
 * Witnesses: matching MEP-IDs stay UP; the broken-LSP case is undone by restoring it.
 * Not built: Poll/Final rate migration, LDI/LKI/LKR inputs, authentication, the
 * independent mode and the PW/Section MEP-ID forms (TODO.md).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress } from '@/network/core/types';
import { MplsLabel } from '@/network/mpls/MplsLabel';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import type { LspMepId } from '@/network/mpls/tp/TpBfd';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });

async function run(router: CiscoRouter, lines: string[]): Promise<void> {
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) await router.executeCommand(line);
}

const ip = (text: string) => new IPAddress(text);

async function lab(mepOverride?: Partial<LspMepId>) {
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
  return { a, b, c };
}


function recordStacks(router: CiscoRouter): number[][] {
  const stacks: number[][] = [];
  const engine = router.getMplsEngine();
  const original = engine.receive.bind(engine);
  engine.receive = (inPort, packet) => { stacks.push(packet.stack.map(entry => entry.label.value)); original(inPort, packet); };
  return stacks;
}

const mep = (nodeId: number, lspNum = 1): LspMepId => ({ globalId: 0, nodeId, tunnelNum: 1, lspNum });

async function withSessions(expectedAtC: LspMepId = mep(1)) {
  const { a, b, c } = await lab();
  a.getTpBfdEngine().enable({ name: 'a', outLsp: 'ac', inLsp: 'ca', localMep: mep(1), expectedRemoteMep: mep(3) });
  c.getTpBfdEngine().enable({ name: 'c', outLsp: 'ca', inLsp: 'ac', localMep: mep(3), expectedRemoteMep: expectedAtC });
  return { a, b, c };
}

describe('BFD CC and CV over the LSP pair (RFC 6428 §3)', () => {
  it('both MEPs reach UP with CC and CV flowing over the G-ACh', async () => {
    const { a, c } = await withSessions();
    clock.advance(5000);
    expect(a.getTpBfdEngine().view('a')).toMatchObject({ state: 'up', diagnostic: 'none' });
    expect(c.getTpBfdEngine().view('c')).toMatchObject({ state: 'up' });
    expect(a.getTpBfdEngine().view('a')!.sent.cc).toBeGreaterThan(0);
    expect(a.getTpBfdEngine().view('a')!.sent.cv).toBeGreaterThan(0);
    expect(c.getTpBfdEngine().view('c')!.received.cv).toBeGreaterThan(0);
  });

  it('the transit LSR only swaps: it never terminates a BFD packet', async () => {
    const { a, b } = await withSessions();
    const atB = recordStacks(b);
    clock.advance(3000);
    expect(atB.length).toBeGreaterThan(0);
    expect(atB.every(stack => stack.length === 2 && stack[1] === 13)).toBe(true);
    expect(b.getMplsTpEngine().counters.received).toBe(0);
    expect(a.getTpBfdEngine().view('a')!.state).toBe('up');
  });

  it('WITNESS: with matching MEP-IDs the session stays UP and reports no mis-connectivity', async () => {
    const { a, c } = await withSessions();
    clock.advance(20000);
    expect(a.getTpBfdEngine().view('a')).toMatchObject({ state: 'up', misconnectivity: false });
    expect(c.getTpBfdEngine().view('c')).toMatchObject({ state: 'up', misconnectivity: false });
  });

  it('a lost direction: the sink MEP times out after 3 intervals with diagnostic 1 (control detection time expired)', async () => {
    const { a, b, c } = await withSessions();
    clock.advance(5000);
    b.getMplsEngine().lfib.removeIlm(MplsLabel.of(1001));
    clock.advance(2500);
    expect(c.getTpBfdEngine().view('c')!.state).toBe('up');
    clock.advance(1500);
    expect(c.getTpBfdEngine().view('c')).toMatchObject({ state: 'down', diagnostic: 'control-detection-time-expired' });
    expect(a).toBeDefined();
  });

  it('the far end learns of it through the DOWN it receives with the diagnostic (RDI) and goes DOWN too', async () => {
    const { a, b } = await withSessions();
    clock.advance(5000);
    b.getMplsEngine().lfib.removeIlm(MplsLabel.of(1001));
    clock.advance(6000);
    const view = a.getTpBfdEngine().view('a')!;
    expect(['down', 'init']).toContain(view.state);
    expect(view.diagnostic).toBe('neighbor-signaled-session-down');
    expect(view.remoteDiagnostic).toBe('control-detection-time-expired');
    expect(view.remoteIndicatesDefect).toBe(true);
  });

  it('WITNESS: restoring the LSP and re-enabling brings the pair back UP', async () => {
    const { a, b, c } = await withSessions();
    clock.advance(5000);
    b.getMplsEngine().lfib.removeIlm(MplsLabel.of(1001));
    clock.advance(6000);
    b.getMplsTpEngine().defineTransit({ inLabel: 1001, iface: 'GigabitEthernet0/1', nextHop: ip('10.2.0.3'), outLabel: 1002 });
    clock.advance(8000);
    expect(a.getTpBfdEngine().view('a')!.state).toBe('up');
    expect(c.getTpBfdEngine().view('c')!.state).toBe('up');
  });

  it('a CV carrying an unexpected Source MEP-ID is a mis-connectivity defect: the sink goes DOWN with diagnostic 9', async () => {
    const { c } = await withSessions(mep(99));
    clock.advance(5000);
    expect(c.getTpBfdEngine().view('c')).toMatchObject({ state: 'down', diagnostic: 'mis-connectivity-defect', misconnectivity: true });
  });

  it('disabling the session sends ADMIN DOWN and the peer leaves UP', async () => {
    const { a, c } = await withSessions();
    clock.advance(5000);
    a.getTpBfdEngine().disable('a');
    clock.advance(1500);
    expect(c.getTpBfdEngine().view('c')!.state).toBe('down');
  });
});

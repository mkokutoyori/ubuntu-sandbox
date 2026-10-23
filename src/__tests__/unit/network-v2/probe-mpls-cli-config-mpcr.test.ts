/**
 * Probe: the LDP/MPLS configuration commands of the Cisco IOS Multiprotocol Label
 * Switching Command Reference (official_docs/cisco/mp-cr-book.pdf: mpls label range,
 * mpls ldp loop-detection | maxhops | path-vector maxlength | holdtime | backoff |
 * explicit-null, mpls ldp discovery targeted-hello holdtime | interval), each
 * checked for its EFFECT on the engine, for its show running-config line and for
 * its `no` form (CLAUDE.md rules 3 and 6).
 * Before the change: 10 of 14 cases fail (the commands are refused). The four that pass
 * either way are refusals the book also makes or that the engine must keep making: a
 * range whose minimum is not below its maximum, a hold time under 15 s, and the two
 * WITNESS cases (explicit-null with an ACL, label range with a static block), which are
 * the rule that nothing is accepted that the engine cannot evaluate.
 * Defaults taken from the book: label range 16/100000 (show sample), maxhops 254,
 * path vector tracks maxhops, holdtime 180, targeted hello 90/10, backoff 15/120.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordSentMessages } from './_ldp-chain-lab';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';
import { LdpIdentifier } from '@/network/ldp/LdpIdentifier';
import { IPAddress } from '@/network/core/types';

let clock: VirtualTimeScheduler;
beforeEach(() => { clock = new VirtualTimeScheduler(); __setDefaultScheduler(clock); });
afterEach(() => vi.restoreAllMocks());

async function run(router: CiscoRouter, lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of lines) out.push(await router.executeCommand(line));
  return out;
}

const config = (router: CiscoRouter, ...lines: string[]) => run(router, ['enable', 'configure terminal', ...lines, 'end']);

async function pair(before?: (r1: CiscoRouter, r2: CiscoRouter) => Promise<void>) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  new Cable('c').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  await config(r1, 'interface Loopback0', 'ip address 1.1.1.1 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.1 255.255.255.0', 'no shutdown', 'exit',
    'ip route 2.2.2.2 255.255.255.255 10.12.0.2');
  await config(r2, 'interface Loopback0', 'ip address 2.2.2.2 255.255.255.255', 'exit',
    'interface GigabitEthernet0/0', 'ip address 10.12.0.2 255.255.255.0', 'no shutdown', 'exit',
    'ip route 1.1.1.1 255.255.255.255 10.12.0.1');
  await before?.(r1, r2);
  await config(r1, 'interface GigabitEthernet0/0', 'mpls ip');
  await config(r2, 'interface GigabitEthernet0/0', 'mpls ip');
  clock.advance(8000);
  return { r1, r2 };
}

const running = (router: CiscoRouter) => router.executeCommand('show running-config');

describe('mpls label range', () => {
  it('moves the allocation range: new local labels fall inside it, and show mpls label range follows', async () => {
    const { r1 } = await pair(async r1 => { await config(r1, 'mpls label range 3000 3999'); });
    expect(await r1.executeCommand('show mpls label range')).toBe('Downstream label pool: Min/Max label: 3000/3999');
    const labels = r1.getLdpEngine().bindings().filter(b => !b.egress).map(b => b.label.value);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every(label => label >= 3000 && label <= 3999)).toBe(true);
  });

  it('is in the running-config, and the no form restores the default', async () => {
    const { r1 } = await pair();
    await config(r1, 'mpls label range 200 120000');
    expect(await running(r1)).toContain('mpls label range 200 120000');
    await config(r1, 'no mpls label range');
    expect(await running(r1)).not.toContain('mpls label range');
    expect(await r1.executeCommand('show mpls label range')).toBe('Downstream label pool: Min/Max label: 16/100000');
  });

  it('refuses a range whose minimum is not below its maximum', async () => {
    const { r1 } = await pair();
    const [, , out] = await config(r1, 'mpls label range 500 400');
    expect(out).toContain('Invalid input');
  });

  it('WITNESS: the static block form is not accepted: no static binding exists to use it', async () => {
    const { r1 } = await pair();
    const [, , out] = await config(r1, 'mpls label range 1000 1048575 static 16 999');
    expect(out).toContain('Invalid input');
  });
});

describe('loop detection commands', () => {
  it('mpls ldp loop-detection switches the Path Vector on the wire and is shown in the parameters', async () => {
    const { r1, r2 } = await pair(async (a, b) => { await config(a, 'mpls ldp loop-detection'); await config(b, 'mpls ldp loop-detection'); });
    expect(r1.getLdpEngine().sessions()[0].negotiated?.loopDetection).toBe(true);
    const parameters = await r1.executeCommand('show mpls ldp parameters');
    expect(parameters).toContain('Downstream on Demand max hop count: 254');
    expect(parameters).toContain('Downstream on Demand Path Vector Limit: 254');
    expect(parameters).toContain('LDP loop detection: on');
    const detail = await r2.executeCommand('show mpls ldp neighbor detail');
    expect(detail).toContain('Path Vector Loop Detection Peer/Local: On/On');
    expect(detail).toContain('Path Vector Limit Peer/Local: 254/254');
  });

  it('maxhops sets the hop limit and the path vector limit follows it until a maxlength is given', async () => {
    const { r1 } = await pair();
    await config(r1, 'mpls ldp loop-detection', 'mpls ldp maxhops 10');
    expect(r1.getLdpEngine().config).toMatchObject({ maxHopCount: 10, pathVectorLimit: 10 });
    await config(r1, 'mpls ldp path-vector maxlength 4', 'mpls ldp maxhops 20');
    expect(r1.getLdpEngine().config).toMatchObject({ maxHopCount: 20, pathVectorLimit: 4 });
    await config(r1, 'no mpls ldp path-vector maxlength');
    expect(r1.getLdpEngine().config.pathVectorLimit).toBe(20);
  });

  it('a path vector maxlength of 0 disables the path vector but keeps the hop count on the wire', async () => {
    const sent = recordSentMessages();
    const { r1, r2 } = await pair(async (a, b) => {
      for (const router of [a, b]) await config(router, 'mpls ldp loop-detection', 'mpls ldp path-vector maxlength 0');
    });
    const mappings = sent.map(entry => entry.message).filter(message => message.kind === 'label-mapping');
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings.every(message => message.hopCount !== undefined)).toBe(true);
    expect(mappings.some(message => message.pathVector !== undefined)).toBe(false);
    expect(r1.getLdpEngine().remoteBindings(LdpIdentifier.of(new IPAddress('2.2.2.2'), 0)).has('2.2.2.2/32')).toBe(true);
    expect(r1.getLdpEngine().loopsDetected + r2.getLdpEngine().loopsDetected).toBe(0);
  });

  it('are in the running-config and the no forms restore the defaults', async () => {
    const { r1 } = await pair();
    await config(r1, 'mpls ldp loop-detection', 'mpls ldp maxhops 10', 'mpls ldp path-vector maxlength 4');
    const text = await running(r1);
    for (const line of ['mpls ldp loop-detection', 'mpls ldp maxhops 10', 'mpls ldp path-vector maxlength 4']) expect(text).toContain(line);
    await config(r1, 'no mpls ldp loop-detection', 'no mpls ldp maxhops', 'no mpls ldp path-vector maxlength');
    const after = await running(r1);
    for (const word of ['loop-detection', 'maxhops', 'path-vector']) expect(after).not.toContain(word);
  });
});

describe('timers and parameters', () => {
  it('holdtime, targeted-hello timers and backoff change the parameters and the running-config, and reset with no', async () => {
    const { r1 } = await pair();
    await config(r1, 'mpls ldp holdtime 60', 'mpls ldp discovery targeted-hello holdtime 120', 'mpls ldp discovery targeted-hello interval 20', 'mpls ldp backoff 30 240');
    const parameters = await r1.executeCommand('show mpls ldp parameters');
    expect(parameters).toContain('Session hold time: 60 sec; keep alive interval: 20 sec');
    expect(parameters).toContain('Discovery targeted hello: holdtime: 120 sec; interval: 20 sec');
    expect(parameters).toContain('LDP initial/maximum backoff: 30/240 sec');
    const text = await running(r1);
    for (const line of ['mpls ldp holdtime 60', 'mpls ldp discovery targeted-hello holdtime 120',
      'mpls ldp discovery targeted-hello interval 20', 'mpls ldp backoff 30 240']) expect(text).toContain(line);
    await config(r1, 'no mpls ldp holdtime', 'no mpls ldp discovery targeted-hello holdtime', 'no mpls ldp discovery targeted-hello interval', 'no mpls ldp backoff');
    expect(await r1.executeCommand('show mpls ldp parameters')).toContain('Session hold time: 180 sec; keep alive interval: 60 sec');
  });

  it('a new session uses the configured hold time', async () => {
    const { r1 } = await pair(async r1 => { await config(r1, 'mpls ldp holdtime 30'); });
    expect(r1.getLdpEngine().sessions()[0].negotiated?.keepAliveTimeSeconds).toBe(30);
  });

  it('refuses a hold time below the 15 s the book allows', async () => {
    const { r1 } = await pair();
    const [, , out] = await config(r1, 'mpls ldp holdtime 10');
    expect(out).toContain('Invalid input');
  });
});

describe('mpls ldp explicit-null', () => {
  it('advertises Explicit Null (label 0) in place of Implicit Null for the directly connected prefixes', async () => {
    const { r1, r2 } = await pair(async (_a, b) => { await config(b, 'mpls ldp explicit-null'); });
    expect(await r1.executeCommand('show mpls ldp bindings 2.2.2.2 32')).toContain('remote binding: lsr: 2.2.2.2:0, label: 0');
    expect(r2.getLdpEngine().bindings().find(b => String(b.fec.prefix) === '2.2.2.2')!.label.value).toBe(0);
  });

  it('is in the running-config and the no form returns to Implicit Null', async () => {
    const { r1, r2 } = await pair(async (_a, b) => { await config(b, 'mpls ldp explicit-null'); });
    expect(await running(r2)).toContain('mpls ldp explicit-null');
    await config(r2, 'no mpls ldp explicit-null');
    clock.advance(1000);
    expect(await r1.executeCommand('show mpls ldp bindings 2.2.2.2 32')).toContain('label: imp-null');
    expect(await running(r2)).not.toContain('explicit-null');
  });

  it('WITNESS: the prefix-acl / peer-acl forms are not accepted: no ACL filtering of advertisements exists', async () => {
    const { r1 } = await pair();
    const [, , out] = await config(r1, 'mpls ldp explicit-null for 10');
    expect(out).toContain('Invalid input');
  });
});

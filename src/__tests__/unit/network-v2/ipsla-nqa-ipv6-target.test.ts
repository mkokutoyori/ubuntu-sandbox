/**
 * IP SLA and NQA measure an IPv6 target.
 *
 * Both subsystems refused one, and both named the SAME reason: no
 * ICMPv6 sender existed on a router. That brick is now in place, so the
 * refusal was the only thing left standing — and on the Cisco side it
 * was not even a refusal. Measured before touching anything:
 *
 *   ip sla 1 / icmp-echo 2001:db8::2   accepted, rendered by
 *   show ip sla configuration 1        `Target address: 2001:db8::2`
 *   show ip sla statistics 1           `Latest RTT: NoConnection`,
 *                                      1 failure, always
 *
 * — accepted, displayed, and read by nothing that could reach it, with
 * the source address rendered as the IPv4 literal `0.0.0.0` beside an
 * IPv6 target. Huawei was at least honest: `destination-address ipv6`
 * answered `IPv6 NQA is not supported in this simulator (no ICMPv6
 * sender on a router)`.
 *
 * What is deliberately still refused, each naming its missing brick
 * rather than accepting an address it cannot reach: every operation
 * type other than `icmp-echo` / `test-type icmp`, because no IPv6
 * transport exists for UDP echo, TCP connect, HTTP or DNS probes here.
 *
 * Discriminated by `git stash`: 6 of the 11 cases fall before the fix.
 * The five that pass either way are named rather than counted as
 * coverage — two are the IPv4 CONTROLS, which must pass on both sides or
 * the lab proves nothing; and three are negative cases that used to
 * "pass" for the wrong reason (the probe failed because the address
 * could not be resolved at all, not because the target was unreachable
 * or the transport missing). They are kept because they now assert the
 * RIGHT reason, and because without them a success would be
 * indistinguishable from an unconditional one.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

afterEach(() => {
  __setDefaultScheduler(null);
});

/** A scheduled operation only runs when the clock does. */
async function settle(ms: number): Promise<void> {
  for (let elapsed = 0; elapsed < ms; elapsed += 10) {
    clock.advance(10);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }
}

async function ciscoPair(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const a = new CiscoRouter('R1');
  const b = new CiscoRouter('R2');
  a.powerOn(); b.powerOn();
  new Cable('c').connect(a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
  for (const [r, v4, v6] of [
    [a, '10.0.0.1', '2001:db8::1'], [b, '10.0.0.2', '2001:db8::2'],
  ] as const) {
    for (const c of [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', `ip address ${v4} 255.255.255.0`,
      `ipv6 address ${v6}/64`, 'no shutdown', 'end',
    ]) await (r as CiscoRouter).executeCommand(c);
  }
  return { a, b };
}

async function armer(r: CiscoRouter, id: number, cible: string): Promise<void> {
  for (const c of [
    'configure terminal', `ip sla ${id}`, `icmp-echo ${cible}`, 'frequency 10', 'exit',
    `ip sla schedule ${id} life forever start-time now`, 'end',
  ]) await r.executeCommand(c);
  await settle(200);
}

async function vrpPair(): Promise<{ a: HuaweiRouter; b: HuaweiRouter }> {
  const a = new HuaweiRouter('AR1');
  const b = new HuaweiRouter('AR2');
  a.powerOn(); b.powerOn();
  const pa = a.getPorts()[0];
  const pb = b.getPorts()[0];
  new Cable('c').connect(pa, pb);
  for (const [r, p, addr] of [[a, pa, '2001:db8::1'], [b, pb, '2001:db8::2']] as const) {
    for (const c of [
      'system-view', 'ipv6', `interface ${p.getName()}`, 'ipv6 enable',
      `ipv6 address ${addr}/64`, 'undo shutdown', 'quit', 'quit',
    ]) await (r as HuaweiRouter).executeCommand(c);
  }
  return { a, b };
}

describe('IP SLA reaches an IPv6 target', () => {
  it('the operation succeeds instead of reporting NoConnection forever', async () => {
    const { a } = await ciscoPair();
    await armer(a, 1, '2001:db8::2');
    const out = await a.executeCommand('show ip sla statistics 1');
    expect(out).toContain('Latest operation return code: OK');
    expect(out).toMatch(/Number of successes: [1-9]/);
    expect(out).toContain('Number of failures: 0');
    expect(out).not.toContain('NoConnection');
  }, 30_000);

  it('an IPv6 address nobody holds fails, so success is not unconditional', async () => {
    const { a } = await ciscoPair();
    await armer(a, 1, '2001:db8::99');
    const out = await a.executeCommand('show ip sla statistics 1');
    expect(out).not.toContain('return code: OK');
    expect(out).toMatch(/Number of failures: [1-9]/);
  }, 30_000);

  it('the IPv4 operation still works — the control case in the same lab', async () => {
    const { a } = await ciscoPair();
    await armer(a, 2, '10.0.0.2');
    const out = await a.executeCommand('show ip sla statistics 2');
    expect(out).toContain('Latest operation return code: OK');
  }, 30_000);

  it('an unset source is `::` beside an IPv6 target, not `0.0.0.0`', async () => {
    const { a } = await ciscoPair();
    await armer(a, 1, '2001:db8::2');
    expect(await a.executeCommand('show ip sla configuration 1'))
      .toContain('Target address/Source address: 2001:db8::2/::');
    await armer(a, 2, '10.0.0.2');
    expect(await a.executeCommand('show ip sla configuration 2'))
      .toContain('Target address/Source address: 10.0.0.2/0.0.0.0');
  }, 30_000);

  it('`track` follows an IPv6 operation, which is what it is configured for', async () => {
    const { a } = await ciscoPair();
    await armer(a, 1, '2001:db8::2');
    for (const c of [
      'configure terminal', 'track 1 ip sla 1 reachability', 'end',
    ]) await a.executeCommand(c);
    expect(await a.executeCommand('show track 1')).toMatch(/Reachability is Up/);
  }, 30_000);

  it('an operation type with no IPv6 transport says which brick is missing', async () => {
    const { a } = await ciscoPair();
    for (const c of [
      'configure terminal', 'ip sla 3', 'udp-echo 2001:db8::2 7000', 'exit',
      'ip sla schedule 3 life forever start-time now', 'end',
    ]) await a.executeCommand(c);
    await settle(200);
    const out = await a.executeCommand('show ip sla statistics 3');
    expect(out).not.toContain('return code: OK');
  }, 30_000);
});

describe('NQA reaches an IPv6 target', () => {
  it('`destination-address ipv6` is accepted and really measures', async () => {
    const { a } = await vrpPair();
    for (const c of [
      'system-view', 'nqa test-instance admin t1', 'test-type icmp',
      'destination-address ipv6 2001:db8::2', 'probe-count 2', 'start now', 'quit', 'quit',
    ]) {
      const out = await a.executeCommand(c);
      expect(out).not.toContain('not supported');
    }
    await settle(15000);
    const res = await a.executeCommand('display nqa results test-instance admin t1');
    expect(res).not.toContain('No result');
    expect(res).toMatch(/success|Success/);
  }, 30_000);

  it('an unreachable IPv6 destination fails, so success is not unconditional', async () => {
    const { a } = await vrpPair();
    for (const c of [
      'system-view', 'nqa test-instance admin t2', 'test-type icmp',
      'destination-address ipv6 2001:db8::99', 'probe-count 1', 'start now', 'quit', 'quit',
    ]) await a.executeCommand(c);
    await settle(15000);
    const res = await a.executeCommand('display nqa results test-instance admin t2');
    expect(res).not.toMatch(/The test is finished, and the result is success/);
  }, 30_000);

  it('a test type with no IPv6 transport is refused, naming the brick', async () => {
    const { a } = await vrpPair();
    for (const c of [
      'system-view', 'nqa test-instance admin t3', 'test-type tcp',
    ]) await a.executeCommand(c);
    const out = await a.executeCommand('destination-address ipv6 2001:db8::2');
    expect(out).toContain('test-type icmp');
  }, 30_000);

  it('a malformed IPv6 literal is refused rather than stored', async () => {
    const { a } = await vrpPair();
    for (const c of [
      'system-view', 'nqa test-instance admin t4', 'test-type icmp',
    ]) await a.executeCommand(c);
    expect(await a.executeCommand('destination-address ipv6 zzz'))
      .toContain('Wrong parameter');
  }, 30_000);

  it('an IPv4 destination still works — the control case', async () => {
    const { a } = await vrpPair();
    const pa = a.getPorts()[0];
    for (const c of [
      'system-view', `interface ${pa.getName()}`, 'ip address 10.0.0.1 255.255.255.0', 'quit',
      'nqa test-instance admin t5', 'test-type icmp',
      'destination-address ipv4 10.0.0.1', 'probe-count 1', 'start now', 'quit', 'quit',
    ]) await a.executeCommand(c);
    await settle(15000);
    expect(await a.executeCommand('display nqa results test-instance admin t5'))
      .not.toContain('No result');
  }, 30_000);
});

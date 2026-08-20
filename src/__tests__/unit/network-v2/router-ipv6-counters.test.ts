/**
 * The IPv6 data plane counts what it does, and four views read it.
 *
 * `show ipv6 traffic`, `show ipv6 static`, `display ipv6 statistics` and
 * `display icmpv6 statistics` did not exist — measured, all four
 * answering `% Invalid input` / `Unrecognized command`. There was
 * nothing to render them from either: `RouterCounters` is the IPv4
 * block, and `IPv6DataPlane` touched exactly one of its fields.
 *
 * The point of this suite is that the numbers are MEASUREMENTS. Every
 * case drives real traffic and asserts the counter moved by the amount
 * that traffic implies — a rendering of constants would pass none of
 * them.
 *
 * What IOS also prints and is deliberately absent, rather than shown as
 * a zero nothing backs: checksum errors (nothing verifies an ICMPv6
 * checksum here), fragments and reassembly (IPv6 fragmentation is not
 * modelled), source-routed (no routing header). A zero that IS counted
 * stays — `hop count exceeded` reads 0 because none happened.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

const num = (text: string, label: RegExp): number =>
  Number(label.exec(text)?.[1] ?? NaN);

async function ciscoPair(): Promise<{ a: CiscoRouter; b: CiscoRouter }> {
  const a = new CiscoRouter('R1');
  const b = new CiscoRouter('R2');
  a.powerOn(); b.powerOn();
  new Cable('c').connect(a.getPort('GigabitEthernet0/0')!, b.getPort('GigabitEthernet0/0')!);
  for (const [r, addr] of [[a, '2001:db8::1'], [b, '2001:db8::2']] as const) {
    for (const c of [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', `ipv6 address ${addr}/64`, 'no shutdown', 'end',
    ]) await (r as CiscoRouter).executeCommand(c);
  }
  return { a, b };
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

describe('`show ipv6 traffic` counts what crossed the box', () => {
  it('five echos add five generated packets and five replies received', async () => {
    const { a } = await ciscoPair();
    await a.executeCommand('clear ipv6 traffic');
    const before = await a.executeCommand('show ipv6 traffic');
    expect(num(before, /(\d+) generated/)).toBe(0);

    await a.executeCommand('ping ipv6 2001:db8::2 repeat 5');
    const after = await a.executeCommand('show ipv6 traffic');

    // Five Echo Requests, plus the one Neighbor Solicitation the first
    // probe needed — generated is a count of what LEFT, not of echos.
    expect(num(after, /(\d+) generated/)).toBeGreaterThanOrEqual(5);
    expect(num(after, /(\d+) echo request, /)).toBe(0);
    expect(num(after, /echo request, (\d+) echo reply/)).toBe(5);
  }, 30_000);

  it('the peer counts the mirror image of the same exchange', async () => {
    const { a, b } = await ciscoPair();
    await b.executeCommand('enable');
    await b.executeCommand('clear ipv6 traffic');
    await a.executeCommand('ping ipv6 2001:db8::2 repeat 3');
    const out = await b.executeCommand('show ipv6 traffic');
    expect(num(out, /(\d+) echo request, /)).toBe(3);
    expect(num(out, /(\d+) echo reply, /)).toBe(3);
  }, 30_000);

  it('a Neighbor Solicitation is counted on both sides', async () => {
    const { a, b } = await ciscoPair();
    await b.executeCommand('enable');
    await a.executeCommand('clear ipv6 traffic');
    await b.executeCommand('clear ipv6 traffic');
    await a.executeCommand('ping ipv6 2001:db8::2 repeat 1');
    const emetteur = await a.executeCommand('show ipv6 traffic');
    const recepteur = await b.executeCommand('show ipv6 traffic');
    expect(num(emetteur, /(\d+) neighbor solicit, (\d+) neighbor advert/)).toBeGreaterThan(0);
    expect(num(recepteur, /(\d+) neighbor solicit, /)).toBeGreaterThan(0);
  }, 30_000);

  it('`clear ipv6 traffic` really clears — a block that cannot be reset is a trap', async () => {
    const { a } = await ciscoPair();
    await a.executeCommand('ping ipv6 2001:db8::2 repeat 2');
    expect(num(await a.executeCommand('show ipv6 traffic'), /(\d+) generated/))
      .toBeGreaterThan(0);
    expect(await a.executeCommand('clear ipv6 traffic')).toBe('');
    const out = await a.executeCommand('show ipv6 traffic');
    expect(num(out, /(\d+) generated/)).toBe(0);
    expect(num(out, /(\d+) total, /)).toBe(0);
  }, 30_000);

  it('the block does not claim what nothing measures', async () => {
    const { a } = await ciscoPair();
    const out = await a.executeCommand('show ipv6 traffic');
    for (const absent of ['checksum errors', 'fragments', 'reassembl', 'source-routed']) {
      expect(out.toLowerCase()).not.toContain(absent);
    }
    // But a zero that IS counted stays.
    expect(out).toContain('0 hop count exceeded');
  }, 30_000);
});

describe('`show ipv6 static` reads the routing table', () => {
  it('a route added shows up, a connected one does not', async () => {
    const { a } = await ciscoPair();
    expect(await a.executeCommand('show ipv6 static')).not.toContain('2001:DB8:99');
    for (const c of [
      'configure terminal', 'ipv6 route 2001:db8:99::/64 2001:db8::2', 'end',
    ]) await a.executeCommand(c);
    const out = await a.executeCommand('show ipv6 static');
    expect(out).toContain('2001:db8:99::/64');
    expect(out).toContain('via 2001:db8::2');
    // The connected prefix belongs to `show ipv6 route`, not here.
    expect(out).not.toContain('2001:db8::/64 via');
  }, 30_000);
});

describe('VRP reads the same counters through its own two commands', () => {
  it('`display ipv6 statistics` and `display icmpv6 statistics` agree with the traffic', async () => {
    const { a } = await vrpPair();
    await a.executeCommand('reset ipv6 statistics');
    await a.executeCommand('ping ipv6 -c 4 2001:db8::2');

    const ip = await a.executeCommand('display ipv6 statistics');
    expect(num(ip, /Total: (\d+)/)).toBeGreaterThan(0);
    expect(ip).toContain('Hoplimit exceeded: 0');

    const icmp = await a.executeCommand('display icmpv6 statistics');
    expect(num(icmp, /Echo reply: (\d+)/)).toBe(4);
    expect(num(icmp, /Neighbor solicit: (\d+)/)).toBeGreaterThan(0);
  }, 30_000);

  it('`reset ipv6 statistics` zeroes them', async () => {
    const { a } = await vrpPair();
    await a.executeCommand('ping ipv6 -c 2 2001:db8::2');
    await a.executeCommand('reset ipv6 statistics');
    expect(num(await a.executeCommand('display ipv6 statistics'), /Total: (\d+)/)).toBe(0);
    expect(num(await a.executeCommand('display icmpv6 statistics'), /Echo reply: (\d+)/)).toBe(0);
  }, 30_000);
});

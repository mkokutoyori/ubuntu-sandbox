/**
 * Three IOS commands that answered something they were not asked.
 *
 * Measured on a live pair of routers:
 *
 *   debug ipv6 nd            -> "IPv6 packet debugging is on for access
 *                                list nd"   (`nd` taken for an ACL name)
 *   debug ipv6 icmp          -> same, with `icmp`
 *   show ipv6 route summary  -> "% Route to summary"  (`summary` taken
 *                                for a destination prefix)
 *
 * `debug ipv6 nd` and `debug ipv6 icmp` are separate commands on IOS,
 * and the data they need was already crossing the wire — Neighbor
 * Solicitations, Advertisements and Echo Requests all pass the very
 * point `debug ipv6 packet` observes. The ICMPv6 type is what separates
 * Neighbor Discovery from the rest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

async function pair(): Promise<{ a: CiscoRouter; b: CiscoRouter; lines: string[] }> {
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
  const lines: string[] = [];
  const svc = (a as unknown as {
    getDebugService(): { subscribe(l: (s: string) => void): () => void };
  }).getDebugService();
  svc.subscribe((l) => lines.push(l));
  return { a, b, lines };
}

describe('`debug ipv6 nd` debugs Neighbor Discovery', () => {
  it('it no longer claims an access list nobody declared', async () => {
    const { a } = await pair();
    const out = await a.executeCommand('debug ipv6 nd');
    expect(out).not.toContain('access list');
    expect(out.toLowerCase()).toContain('neighbor discovery');
  }, 30_000);

  it('a real Neighbor Solicitation shows up under it', async () => {
    const { a, lines } = await pair();
    await a.executeCommand('debug ipv6 nd');
    await a.executeCommand('ping ipv6 2001:db8::2 repeat 1');
    expect(lines.some((l) => /ICMPv6-ND: Sending NS for 2001:db8::2/i.test(l))).toBe(true);
    expect(lines.some((l) => /ICMPv6-ND: Received NA/i.test(l))).toBe(true);
    // Neighbor Discovery is not an echo: the echo lines belong to the
    // OTHER command and must not leak into this one.
    expect(lines.some((l) => /echo/i.test(l))).toBe(false);
  }, 30_000);

  it('`debug ipv6 icmp` sees the echo, and not the discovery', async () => {
    const { a, lines } = await pair();
    await a.executeCommand('debug ipv6 icmp');
    await a.executeCommand('ping ipv6 2001:db8::2 repeat 1');
    expect(lines.some((l) => /ICMPv6: Sending echo-request/i.test(l))).toBe(true);
    expect(lines.some((l) => /ICMPv6: Received echo-reply/i.test(l))).toBe(true);
    expect(lines.some((l) => /ICMPv6-ND/.test(l))).toBe(false);
  }, 30_000);

  it('the two are separate switches, and `no` turns off only its own', async () => {
    const { a, lines } = await pair();
    await a.executeCommand('debug ipv6 nd');
    await a.executeCommand('debug ipv6 icmp');
    await a.executeCommand('no debug ipv6 nd');
    await a.executeCommand('ping ipv6 2001:db8::2 repeat 1');
    expect(lines.some((l) => /ICMPv6-ND/.test(l))).toBe(false);
    expect(lines.some((l) => /ICMPv6: /.test(l))).toBe(true);
  }, 30_000);

  it('a keyword IOS does not have is refused, not stored as an ACL', async () => {
    const { a } = await pair();
    expect(await a.executeCommand('debug ipv6 zzz'))
      .toContain('% Invalid input detected');
  }, 30_000);

  it('`debug ipv6 packet` still takes an access list', async () => {
    const { a } = await pair();
    expect(await a.executeCommand('debug ipv6 packet MYLIST')).toContain('MYLIST');
  }, 30_000);
});

describe('`show ipv6 route summary` counts the table', () => {
  it('it is a summary and not a destination named "summary"', async () => {
    const { a } = await pair();
    const out = await a.executeCommand('show ipv6 route summary');
    expect(out).not.toContain('% Route to');
    expect(out).toContain('Route Source');
    expect(out).toContain('Total');
  }, 30_000);

  it('every number is counted on the live table', async () => {
    const { a } = await pair();
    const avant = await a.executeCommand('show ipv6 route summary');
    const lireTotal = (t: string) => Number(/^Total\s+(\d+)/m.exec(t)?.[1]);
    const n = lireTotal(avant);
    expect(n).toBeGreaterThan(0);

    for (const c of [
      'configure terminal', 'ipv6 route 2001:db8:99::/64 2001:db8::2', 'end',
    ]) await a.executeCommand(c);
    const apres = await a.executeCommand('show ipv6 route summary');
    expect(lireTotal(apres)).toBe(n + 1);
    expect(apres).toMatch(/^static\s+1\s/m);
  }, 30_000);
});

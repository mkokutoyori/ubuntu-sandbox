/**
 * A router pings an IPv6 address, and the packet crosses the wire.
 *
 * Measured before writing a line: a Cisco router answered
 * `% Unrecognized host or address, or protocol not running.` to
 * `ping ipv6 2001:db8::2` on a link where `show ipv6 interface brief`
 * listed the address of BOTH ends, and a Huawei one answered
 * `Error: Unknown host 2001:db8::2.`. The cause was not the parser: the
 * data plane ANSWERED an Echo Request and could not send one, so no
 * router had an ICMPv6 emitter at all. That absence is what `PRD-IP-SLA`
 * and `PRD-NQA` both name as the missing brick behind their own refusal
 * of IPv6 targets.
 *
 * The neighbour cache was real and unviewable on both platforms — no
 * `show ipv6 neighbors`, no `display ipv6 neighbors` anywhere in the
 * repo — so an operator could not tell an unresolved next hop from an
 * unreachable one.
 *
 * Discriminated by `git stash`: 11 of the 13 cases fall before the fix.
 * The two that pass either way are named rather than left to look like
 * coverage — the malformed literal was refused by a command that did not
 * exist at all, and the host-pings-router case passes because the host
 * does NDP first, so the router's cache is already warm when the Echo
 * Request lands. That second one guards a robustness fix (the reply path
 * now solicits an unknown sender instead of dropping it silently) whose
 * effect no topology here can currently provoke.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { IPv6Address, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { Equipment } from '@/network/equipment/Equipment';
import type { EthernetFrame, IPv6Packet, ICMPv6Packet } from '@/network/core/types';
import { pingOnSimulatedClock } from '../../support/fastPing';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

/** Every ICMPv6 type crossing this machine's own ports, in order. */
function watchIcmpv6(source: Equipment): string[] {
  const seen: string[] = [];
  source.attachCapture(({ frame }) => {
    const pkt = frame.payload as IPv6Packet | undefined;
    if (!pkt || pkt.type !== 'ipv6') return;
    const icmp = pkt.payload as ICMPv6Packet | undefined;
    if (icmp?.type === 'icmpv6') seen.push(icmp.icmpType);
  });
  return seen;
}

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

describe('a Cisco router pings IPv6', () => {
  it('`ping ipv6` succeeds and really sends Echo Requests', async () => {
    const { a } = await ciscoPair();
    const icmp = watchIcmpv6(a);
    const out = await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::2');
    expect(out).toContain('Sending 5, 100-byte ICMP Echos to 2001:db8::2');
    expect(out).toMatch(/Success rate is 100 percent \(5\/5\)/);
    // The transcript alone proves nothing — a fabricated success reads
    // the same. What proves it is the wire.
    expect(icmp.filter((t) => t === 'echo-request')).toHaveLength(5);
    expect(icmp.filter((t) => t === 'echo-reply')).toHaveLength(5);
  }, 30_000);

  it('a bare `ping <ipv6>` takes the same path — IOS needs no keyword', async () => {
    const { a } = await ciscoPair();
    const out = await pingOnSimulatedClock(a, 'ping 2001:db8::2');
    expect(out).toMatch(/Success rate is 100 percent/);
  }, 30_000);

  it('`repeat` and `size` reach the probe', async () => {
    const { a } = await ciscoPair();
    const icmp = watchIcmpv6(a);
    const out = await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::2 repeat 2 size 200');
    expect(out).toContain('Sending 2, 200-byte ICMP Echos');
    expect(out).toMatch(/\(2\/2\)/);
    expect(icmp.filter((t) => t === 'echo-request')).toHaveLength(2);
  }, 30_000);

  it('an address nobody holds times out rather than pretending', async () => {
    const { a } = await ciscoPair();
    const out = await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::99 repeat 2');
    expect(out).toMatch(/Success rate is 0 percent/);
  }, 30_000);

  it('a malformed literal is still refused', async () => {
    const { a } = await ciscoPair();
    expect(await pingOnSimulatedClock(a, 'ping ipv6 zzzz'))
      .toBe('% Unrecognized host or address, or protocol not running.');
  }, 30_000);

  it('its own address answers without leaving the box', async () => {
    const { a } = await ciscoPair();
    const icmp = watchIcmpv6(a);
    const out = await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::1 repeat 2');
    expect(out).toMatch(/Success rate is 100 percent/);
    expect(icmp.filter((t) => t === 'echo-request')).toHaveLength(0);
  }, 30_000);
});

describe('a Huawei router pings IPv6', () => {
  it('`ping ipv6` reports hop limit, and the requests are real', async () => {
    const { a } = await vrpPair();
    const icmp = watchIcmpv6(a);
    const out = await pingOnSimulatedClock(a, 'ping ipv6 -c 3 2001:db8::2');
    expect(out).toContain('PING 2001:db8::2 : 56  data bytes');
    // `hop limit` and not `ttl`: IPv6 has no TTL field, and VRP says so.
    expect(out).toMatch(/hop limit=64/);
    expect(out).toContain('3 packet(s) transmitted');
    expect(out).toContain('3 packet(s) received');
    expect(out).toContain('0.00% packet loss');
    expect(icmp.filter((t) => t === 'echo-request')).toHaveLength(3);
  }, 30_000);

  it('a bare `ping <ipv6>` takes the same path', async () => {
    const { a } = await vrpPair();
    const out = await pingOnSimulatedClock(a, 'ping -c 2 2001:db8::2');
    expect(out).toContain('2 packet(s) received');
  }, 30_000);

  it('an unreachable address loses every packet', async () => {
    const { a } = await vrpPair();
    const out = await pingOnSimulatedClock(a, 'ping ipv6 -c 2 2001:db8::99');
    expect(out).toContain('0 packet(s) received');
    expect(out).toContain('100.00% packet loss');
  }, 30_000);
});

describe('a router answers a host that has never spoken to it', () => {
  it('the first Echo Request from a PC is replied to', async () => {
    const r = new CiscoRouter('R1');
    const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
    r.powerOn(); pc.powerOn();
    new Cable('c').connect(r.getPort('GigabitEthernet0/0')!, pc.getPort('eth0')!);
    for (const c of [
      'enable', 'configure terminal', 'ipv6 unicast-routing',
      'interface GigabitEthernet0/0', 'ipv6 address 2001:db8::1/64', 'no shutdown', 'end',
    ]) await r.executeCommand(c);
    (pc as unknown as {
      configureIPv6Interface(i: string, a: IPv6Address, p: number): boolean;
    }).configureIPv6Interface('eth0', new IPv6Address('2001:db8::10'), 64);

    const out = await pingOnSimulatedClock(pc, 'ping -6 -c 2 2001:db8::1');
    expect(out).toMatch(/2 received|0% packet loss/);
  }, 30_000);
});

describe('the neighbour cache is viewable', () => {
  it('IOS renders it, with the MAC in its own notation', async () => {
    const { a } = await ciscoPair();
    await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::2 repeat 1');
    const out = await a.executeCommand('show ipv6 neighbors');
    expect(out.split('\n')[0])
      .toBe('IPv6 Address                              Age Link-layer Addr State Interface');
    expect(out).toContain('2001:DB8::2');
    // `0011.2233.4455`, never `00:11:22:33:44:55`, on an IOS view.
    expect(out).toMatch(/[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}/);
    expect(out).toMatch(/REACH|STALE/);
    expect(out).toContain('Gi0/0');
    const ages = [...out.matchAll(/^\S+\s+(\d+|-) /gm)].map((m) => m[1]);
    expect(ages.every((a) => a === '-' || Number(a) < 60)).toBe(true);
  }, 30_000);

  it('VRP renders the same cache as records, with its own fields', async () => {
    const { a } = await vrpPair();
    await pingOnSimulatedClock(a, 'ping ipv6 -c 1 2001:db8::2');
    const out = await a.executeCommand('display ipv6 neighbors');
    expect(out).toContain('IPv6 Address : 2001:DB8::2');
    expect(out).toMatch(/Link-layer   : [0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}/);
    expect(out).toMatch(/Is Router: TRUE/);
    // Two records for one neighbour is right, not a duplicate: NDP
    // resolves its LINK-LOCAL address as well as the global one, and
    // they are different addresses on the same MAC.
    expect(out).toMatch(/FE80::/);
    expect(out).toMatch(/Total: 2 {8}Dynamic: 2 {5}Static: 0/);
    // The age is in the cache's own clock, so a fresh entry is seconds
    // old and not fifty-six years.
    const age = Number(/Age   : (\d+)/.exec(out)?.[1]);
    expect(age).toBeLessThan(60);
  }, 30_000);

  it('an empty cache renders its header and no row', async () => {
    const r = new CiscoRouter('R9');
    r.powerOn();
    await r.executeCommand('enable');
    const out = await r.executeCommand('show ipv6 neighbors');
    expect(out.split('\n')).toHaveLength(1);
    expect(out).toContain('IPv6 Address');
  }, 30_000);
});

describe('a router traces an IPv6 route', () => {
  it('IOS reaches the destination in one hop, over real packets', async () => {
    const { a } = await ciscoPair();
    const icmp = watchIcmpv6(a);
    const out = await a.executeCommand('traceroute ipv6 2001:db8::2');
    expect(out).toContain('Tracing the route to 2001:db8::2');
    expect(out).toContain('2001:db8::2');
    expect(icmp.filter((t) => t === 'echo-request').length).toBeGreaterThan(0);
  }, 30_000);

  it('a bare `traceroute <ipv6>` takes the same path', async () => {
    const { a } = await ciscoPair();
    const out = await a.executeCommand('traceroute 2001:db8::2');
    expect(out).toContain('2001:db8::2');
    expect(out).not.toContain('Unrecognized host');
  }, 30_000);

  it('VRP traces it too', async () => {
    const { a } = await vrpPair();
    const out = await a.executeCommand('tracert ipv6 2001:db8::2');
    expect(out).toContain('2001:db8::2');
    expect(out).not.toContain('Unknown host');
  }, 30_000);
});

describe('the cache can be emptied', () => {
  it('IOS `clear ipv6 neighbors` really empties it', async () => {
    const { a } = await ciscoPair();
    await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::2 repeat 1');
    expect(await a.executeCommand('show ipv6 neighbors')).toContain('2001:DB8::2');
    expect(await a.executeCommand('clear ipv6 neighbors')).toBe('');
    expect(await a.executeCommand('show ipv6 neighbors')).not.toContain('2001:DB8::2');
  }, 30_000);

  it('VRP `reset ipv6 neighbors` really empties it', async () => {
    const { a } = await vrpPair();
    await pingOnSimulatedClock(a, 'ping ipv6 -c 1 2001:db8::2');
    expect(await a.executeCommand('display ipv6 neighbors')).toContain('2001:DB8::2');
    await a.executeCommand('reset ipv6 neighbors');
    expect(await a.executeCommand('display ipv6 neighbors')).toContain('Total: 0');
  }, 30_000);
});

describe('an address is rendered as an address', () => {
  it('no view uppercases a zone index or glues a prefix to it', async () => {
    const { a } = await ciscoPair();
    await pingOnSimulatedClock(a, 'ping ipv6 2001:db8::2 repeat 1');
    const ios = await a.executeCommand('show ipv6 neighbors');
    // The zone is an interface name, not part of the 128 bits.
    expect(ios).not.toContain('%');
    expect(ios).not.toContain('GIGABITETHERNET');

    const { a: v } = await vrpPair();
    await pingOnSimulatedClock(v, 'ping ipv6 -c 1 2001:db8::2');
    expect(await v.executeCommand('display ipv6 neighbors')).not.toContain('%');
  }, 30_000);

  it('VRP\'s brief view puts one address per row, unmangled', async () => {
    const { a } = await vrpPair();
    const out = await a.executeCommand('display ipv6 interface brief');
    // `fe80::ff:fe00:1%GE0/0/0/64` was an address that does not exist,
    // and `…/64up` was the state glued onto an overflowed column.
    expect(out).not.toMatch(/%\S*\/64/);
    expect(out).not.toMatch(/\/64up/);
    const lignes = out.split('\n');
    expect(lignes[0]).toMatch(/^Interface\s+IPv6 Address\s+State$/);
    // The link-local comes first, on the interface's own row; the
    // global address gets a continuation row of its own.
    expect(lignes[1]).toMatch(/^GE0\/0\/0\s+fe80::\S+\s+up$/);
    expect(lignes[2]).toMatch(/^\s+2001:db8::1\/64$/);
  }, 30_000);
});

/**
 * An IPv6 access list FILTERS, and one interface has one configuration.
 *
 * Measured on a live pair of routers before writing a line: a list whose
 * first line is `deny icmp any any`, applied with
 * `ipv6 traffic-filter BLOCK in`, let a ping through at 100 %.
 * `ipv6 access-list` parsed real structured entries and
 * `show ipv6 access-list` rendered them — and nothing anywhere read
 * either. A security feature that is accepted, displayed, and filters
 * nothing is worse than an absent one, because it reads as protection.
 *
 * The rule that is easy to miss and load-bearing: IOS implicitly permits
 * Neighbor Discovery at the END of every IPv6 ACL, before the implicit
 * deny. Without it, applying any IPv6 ACL kills NDP and takes the link
 * down with it — an implementation that stopped at "implicit deny" would
 * pass a review and destroy every lab that used it. APPENDED is the
 * word: an entry the operator wrote matches first, so an explicit
 * `deny ipv6 any any` really does black-hole the link, which is why IOS
 * warns against it. Both halves are pinned, because making the warning
 * not come true would teach the opposite of the truth.
 *
 * The measurement also uncovered a defect with nothing to do with access
 * lists, found because the three-router lab's IPv4 control passed while
 * its IPv6 twin lost every packet: an ICMPv6 Echo Reply — and an ICMPv6
 * ERROR with it — was handed to the neighbour whose address the asker
 * carried, instead of being routed. That works exactly while the asker
 * is on the same link; a router two hops away got no reply at all,
 * because the Neighbor Solicitation went out on a segment that does not
 * hold that address. It also meant a `traceroute ipv6` past the first
 * hop could never work, Hop Limit Exceeded being by definition an answer
 * to somebody far away.
 *
 * Found in the same pass, and the reason the first measurement looked
 * like the binding had been dropped: `show running-config interface
 * <name>` was a SECOND hand-written renderer of the interface block that
 * knew a subset of the first's lines. On one machine at one instant the
 * full configuration listed `ipv6 address` and `ipv6 traffic-filter`
 * where the per-interface view showed neither.
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

/** R1 — R2 — R3, so a filter can be applied to TRANSIT traffic too. */
async function lab(): Promise<{ r1: CiscoRouter; r2: CiscoRouter; r3: CiscoRouter }> {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');
  for (const r of [r1, r2, r3]) r.powerOn();
  new Cable('a').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('b').connect(r2.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

  const cfg = async (r: CiscoRouter, lines: string[]) => {
    for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
      ...lines, 'end']) await r.executeCommand(c);
  };
  await cfg(r1, [
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::1/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:2::/64 2001:db8:1::2',
  ]);
  await cfg(r2, [
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:1::2/64', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ipv6 address 2001:db8:2::1/64', 'no shutdown', 'exit',
  ]);
  await cfg(r3, [
    'interface GigabitEthernet0/0', 'ipv6 address 2001:db8:2::2/64', 'no shutdown', 'exit',
    'ipv6 route 2001:db8:1::/64 2001:db8:2::1',
  ]);
  return { r1, r2, r3 };
}

const rate = (out: string): number => Number(/Success rate is (\d+) percent/.exec(out)?.[1] ?? NaN);

describe('an inbound IPv6 filter really drops', () => {
  it('`deny icmp any any` stops the ping it was written to stop', async () => {
    const { r1 } = await lab();
    // The control: without the filter, the same ping succeeds.
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(100);
    for (const c of [
      'configure terminal', 'ipv6 access-list BLOCK', 'deny icmp any any',
      'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter BLOCK in', 'end',
    ]) await r1.executeCommand(c);
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(0);
  }, 30_000);

  it('a filter that permits does not drop — deny is not the only outcome', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'ipv6 access-list PASS', 'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter PASS in', 'end',
    ]) await r1.executeCommand(c);
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(100);
  }, 30_000);

  it('the implicit deny at the end of the list applies', async () => {
    const { r1 } = await lab();
    // Nothing matches an echo reply, so the implicit deny takes it.
    for (const c of [
      'configure terminal', 'ipv6 access-list ONLYTCP', 'permit tcp any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter ONLYTCP in', 'end',
    ]) await r1.executeCommand(c);
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(0);
  }, 30_000);

  it('Neighbor Discovery survives a list that simply does not mention it', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'ipv6 access-list ONLYTCP', 'permit tcp any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter ONLYTCP in', 'end',
    ]) await r1.executeCommand(c);
    await r1.executeCommand('clear ipv6 neighbors');
    await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 1');
    // The ping falls to the implicit deny, but the neighbour was still
    // resolved: the implicit `permit icmp any any nd-na`/`nd-ns` sit
    // ahead of it, and without them the link would go dark.
    expect(await r1.executeCommand('show ipv6 neighbors')).toContain('2001:DB8:1::2');
  }, 30_000);

  it('an EXPLICIT `deny ipv6 any any` does block Neighbor Discovery — the documented trap', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'ipv6 access-list NOTHING', 'deny ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter NOTHING in', 'end',
    ]) await r1.executeCommand(c);
    await r1.executeCommand('clear ipv6 neighbors');
    await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 1');
    // The implicit ND permits are APPENDED to the list, so an entry the
    // operator wrote matches first. This is why IOS warns against
    // ending an IPv6 ACL that way, and reproducing the warning as
    // working behaviour would teach the opposite of the truth.
    expect(await r1.executeCommand('show ipv6 neighbors')).not.toContain('2001:DB8:1::2');
  }, 30_000);

  it('a source prefix narrows the match instead of catching everything', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'ipv6 access-list ELSEWHERE',
      'deny icmp 2001:db8:9::/64 any', 'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter ELSEWHERE in', 'end',
    ]) await r1.executeCommand(c);
    // The deny names a prefix the peer does not have, so it must not fire.
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(100);
  }, 30_000);

  it('the filter is bound to its own direction, not to both', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'ipv6 access-list BLOCK', 'deny icmp any any',
      'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter BLOCK out', 'end',
    ]) await r1.executeCommand(c);
    // Outbound filters transit traffic only; this router originates the
    // echo itself, and its reply arrives INbound.
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(100);
  }, 30_000);

  it('an outbound filter stops TRANSIT traffic', async () => {
    const { r1, r2 } = await lab();
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:2::2 repeat 2'))).toBe(100);
    for (const c of [
      'configure terminal', 'ipv6 access-list NOTRANSIT', 'deny icmp any any',
      'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/1', 'ipv6 traffic-filter NOTRANSIT out', 'end',
    ]) await r2.executeCommand(c);
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:2::2 repeat 2'))).toBe(0);
  }, 30_000);

  it('a drop is COUNTED, not merely silent', async () => {
    const { r1 } = await lab();
    // The neighbour is resolved BEFORE the filter goes on, so what the
    // counter sees afterwards is the denied echo replies and nothing
    // else — `deny icmp any any` would otherwise also stop the NA and
    // the count would be of one dropped advertisement.
    await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 1');
    for (const c of [
      'configure terminal', 'ipv6 access-list BLOCK', 'deny icmp any any',
      'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'ipv6 traffic-filter BLOCK in', 'end',
    ]) await r1.executeCommand(c);
    await r1.executeCommand('clear ipv6 traffic');
    await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 3');
    const out = await r1.executeCommand('show ipv6 traffic');
    expect(Number(/(\d+) access denied/.exec(out)?.[1])).toBe(3);
  }, 30_000);

  it('a list bound before it is written filters nothing', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'interface GigabitEthernet0/0',
      'ipv6 traffic-filter LATER in', 'end',
    ]) await r1.executeCommand(c);
    // IOS's own configuration order writes the binding before the list,
    // so a forward reference must not black-hole the interface.
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:1::2 repeat 2'))).toBe(100);
  }, 30_000);
});

describe('one interface has one configuration', () => {
  it('the per-interface view and the full one agree', async () => {
    const { r1 } = await lab();
    for (const c of [
      'configure terminal', 'ipv6 access-list BLOCK', 'permit ipv6 any any', 'exit',
      'interface GigabitEthernet0/0', 'description LINK',
      'ip address 10.0.0.1 255.255.255.0', 'ipv6 traffic-filter BLOCK in', 'end',
    ]) await r1.executeCommand(c);

    const un = await r1.executeCommand('show running-config interface GigabitEthernet0/0');
    const tout = await r1.executeCommand('show running-config');
    const bloc = tout.split('!')
      .find((b) => b.includes('interface GigabitEthernet0/0'))!;

    for (const ligne of [
      ' description LINK',
      ' ip address 10.0.0.1 255.255.255.0',
      ' ipv6 address 2001:db8:1::1/64',
      ' ipv6 traffic-filter BLOCK in',
    ]) {
      expect(bloc, `la configuration complète doit porter "${ligne}"`).toContain(ligne);
      expect(un, `la vue par interface doit porter "${ligne}"`).toContain(ligne);
    }
  }, 30_000);
});

describe('an ICMPv6 answer is ROUTED, not handed to a neighbour', () => {
  it('a router two hops away is reachable', async () => {
    const { r1 } = await lab();
    expect(rate(await r1.executeCommand('ping ipv6 2001:db8:2::2 repeat 3'))).toBe(100);
  }, 30_000);

  it('`traceroute ipv6` shows both hops, each by its global address', async () => {
    const { r1 } = await lab();
    const out = await r1.executeCommand('traceroute ipv6 2001:db8:2::2');
    const hops = out.split('\n').filter((l) => /^\s+\d+\s/.test(l));
    expect(hops).toHaveLength(2);
    // The intermediate hop answers with the address of the interface the
    // packet came in on (RFC 4443 §2.2), global when it has one — and a
    // zone index is local metadata that never goes on the wire.
    expect(hops[0]).toContain('2001:db8:1::2');
    expect(hops[0]).not.toContain('%');
    expect(hops[1]).toContain('2001:db8:2::2');
  }, 30_000);
});

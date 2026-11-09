/*
 * Probe: `get router info bgp neighbors` printed a neighbour's state and message counts only. The capture that ntc-templates keeps
 * for `fortinet_get_router_info_bgp_neighbors` (a real FortiGate) also carries, per neighbour: `Configured hold time is H, keepalive
 * interval is K seconds`, `Neighbor capabilities:` with `Address family IPv4 Unicast: advertised and received`, then a
 * ` For address family: IPv4 Unicast` block with `BGP table version V, neighbor version S`, `Inbound path policy configured` and
 * `Route map for incoming advertisements is *NAME` when a route-map-in is set, `N accepted prefixes, M prefixes in rib` and
 * `K announced prefixes`. The engine holds all of it (Adj-RIB-In, Adj-RIB-Out, selected paths, table version): the view now prints
 * it, in the capture's wording. `get router info bgp neighbors A.B.C.D` prints that one neighbour. Lines the engine cannot answer
 * (Route refresh, IPv6 family, Additional Path, connection counters, local and foreign ports, last reset) are not printed.
 * The three views `advertised-routes`, `routes` and `received-routes` have no capture here and stay unknown (TODO.md).
 *
 * Two FortiGate peer; A advertises 172.16.0.0/16 and B holds a route-map-in.
 * Discriminated with git stash on src/network: 5 of 6 fall before the change; the witness (the session is up and the state line
 * is printed) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

async function type(device: { executeCommand(c: string): Promise<string> }, lines: readonly string[]): Promise<void> {
  for (const line of lines) await device.executeCommand(line);
}

let clock: VirtualTimeScheduler;
beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function pair() {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('port2')!, b.getPort('port2')!);
  await type(a, [
    'config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next', 'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'end',
    'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002', 'next', 'end', 'end']);
  await type(b, [
    'config system interface', 'edit port2', 'set ip 10.9.0.2 255.255.255.0', 'next', 'end',
    'config router prefix-list', 'edit "p"', 'config rule', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'set action permit', 'next', 'end', 'next', 'end',
    'config router route-map', 'edit "from-a"', 'config rule', 'edit 1', 'set match-ip-address "p"', 'next', 'end', 'next', 'end',
    'config router bgp', 'set as 65002', 'set router-id 2.2.2.2',
    'config neighbor', 'edit "10.9.0.1"', 'set remote-as 65001', 'set route-map-in "from-a"', 'next', 'end', 'end']);
  clock.advance(240_000);
  return { a, b };
}

describe('get router info bgp neighbors, address family', () => {
  it('witness: the session is up and the state line is printed', async () => {
    const { b } = await pair();
    expect(await b.executeCommand('get router info bgp neighbors')).toContain('BGP state = Established');
  });

  it('prints the configured timers and the IPv4 capability', async () => {
    const { b } = await pair();
    const out = await b.executeCommand('get router info bgp neighbors');
    expect(out).toMatch(/Configured hold time is \d+, keepalive interval is \d+ seconds/);
    expect(out).toContain('    Address family IPv4 Unicast: advertised and received');
  });

  it('counts accepted, selected and announced prefixes', async () => {
    const { a, b } = await pair();
    const received = await b.executeCommand('get router info bgp neighbors');
    expect(received).toContain(' For address family: IPv4 Unicast');
    expect(received).toMatch(/1 accepted prefixes, 1 prefixes in rib/);
    expect(await a.executeCommand('get router info bgp neighbors')).toMatch(/\n  1 announced prefixes/);
  });

  it('names the inbound route-map as the capture does', async () => {
    const { b } = await pair();
    const out = await b.executeCommand('get router info bgp neighbors');
    expect(out).toContain('  Inbound path policy configured');
    expect(out).toContain('  Route map for incoming advertisements is *from-a');
  });

  it('prints the table version of the family', async () => {
    const { b } = await pair();
    expect(await b.executeCommand('get router info bgp neighbors')).toMatch(/BGP table version \d+, neighbor version \d+/);
  });

  it('prints a single neighbour on request and leaves an unknown address unknown', async () => {
    const { b } = await pair();
    expect(await b.executeCommand('get router info bgp neighbors 10.9.0.1')).toContain('BGP neighbor is 10.9.0.1');
    expect(await b.executeCommand('get router info bgp neighbors 10.9.0.77')).toMatch(/Command fail|unknown/i);
  });
});

/*
 * Probe: FortiOS 7.4.12 documents `set bfd [enable|disable]` in `config router ospf` (p.1157) and `set bfd [global|enable|disable]`
 * in `config ospf-interface`. The schema carried neither, and no FortiGate OSPF adjacency was ever torn down by BFD. The unit now
 * asks its BFD agent for a session toward every Full neighbour on an interface where BFD is wanted (the interface setting, or the
 * global one when the interface says `global`), and a session that goes down kills the neighbour at once instead of waiting out
 * the dead interval (RFC 5882 §4.1, RFC 5880).
 *
 * Two FortiGate run OSPF over a cable; A advertises 172.16.0.0/16. A's link is then cut: B has a route to it for as long as the
 * adjacency lives. With BFD it is gone within the detection time (a few seconds), without it only after the 40 s dead interval.
 * Discriminated with git stash on src/network: 2 of 5 fall before the change (interface enable, global). Three pass either way:
 * the adjacency witness, the no-BFD witness (the route outlives 5 s), and the interface `disable` override, which holds before
 * the change only because nothing ever dropped the neighbour early.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

async function type(device: { executeCommand(c: string): Promise<string> }, commands: readonly string[]): Promise<string[]> {
  const replies: string[] = [];
  for (const command of commands) replies.push(await device.executeCommand(command));
  return replies;
}

let clock: VirtualTimeScheduler;
beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const ospf = (id: string, global: boolean, iface: string | null) => [
  'config router ospf', `set router-id ${id}`, ...(global ? ['set bfd enable'] : []),
  'config area', 'edit 0.0.0.0', 'next', 'end',
  'config network', 'edit 1', 'set prefix 10.9.0.0 255.255.255.0', 'set area 0.0.0.0', 'next',
  'edit 2', 'set prefix 172.16.0.0 255.255.0.0', 'set area 0.0.0.0', 'next', 'end',
  'config ospf-interface', 'edit "x"', 'set interface "port2"', ...(iface === null ? [] : [`set bfd ${iface}`]), 'next', 'end', 'end'];

async function pair(global: boolean, iface: string | null) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('port2')!, b.getPort('port2')!);
  await type(a, ['config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next', 'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end', ...ospf('1.1.1.1', global, iface)]);
  await type(b, ['config system interface', 'edit port2', 'set ip 10.9.0.2 255.255.255.0', 'next', 'end', ...ospf('2.2.2.2', global, iface)]);
  clock.advance(120_000);
  return { a, b };
}

const routeOf = async (b: FortiGate) => (await b.executeCommand('get router info routing-table all')).includes('172.16.0.0');
const cutA = (a: FortiGate) => type(a, ['config system interface', 'edit port2', 'set status down', 'next', 'end']);

describe('ospf with bfd', () => {
  it('witness: the adjacency forms and B learns the route', async () => {
    const { b } = await pair(false, null);
    expect(await routeOf(b)).toBe(true);
  });

  it('witness: without BFD the route outlives the first seconds after a cut', async () => {
    const { a, b } = await pair(false, null);
    await cutA(a);
    clock.advance(5_000);
    expect(await routeOf(b)).toBe(true);
  });

  it('the interface setting enable drops the neighbour within the BFD detection time', async () => {
    const { a, b } = await pair(false, 'enable');
    await cutA(a);
    clock.advance(5_000);
    expect(await routeOf(b)).toBe(false);
  });

  it('the global setting reaches an interface left on global', async () => {
    const { a, b } = await pair(true, null);
    await cutA(a);
    clock.advance(5_000);
    expect(await routeOf(b)).toBe(false);
  });

  it('an interface set to disable overrides the global setting', async () => {
    const { a, b } = await pair(true, 'disable');
    await cutA(a);
    clock.advance(5_000);
    expect(await routeOf(b)).toBe(true);
  });
});

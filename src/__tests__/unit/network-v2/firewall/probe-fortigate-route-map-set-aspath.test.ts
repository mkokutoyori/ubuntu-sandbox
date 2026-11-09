/*
 * Probe: FortiOS 7.4.12 (router route-map > config rule, p.1200) documents `set-aspath <as1> <as2> ...` ("Use quotes for repeating
 * numbers, for example "1 1 2"") and `set-aspath-action [prepend|replace]`. The schema carried neither, so a prepend route-map was
 * refused at its first line, and the BGP engine had no way to edit an AS_PATH from policy. The route-map now carries both, the
 * decision travels to BGPEngine (inbound edits the Adj-RIB-In path, outbound edits the advertised path before the local AS is
 * prepended, RFC 4271 §5.1.2), and a non-numeric or out-of-range AS number is refused at commit.
 *
 * Two FortiGate are paired on a cable: A (AS 65001) advertises 172.16.0.0/16 to B (AS 65002).
 * Discriminated with git stash on src/network: 4 of 5 fall before the change; the witness (no route-map: B sees the plain path
 * [65001]) passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { Cable } from '@/network/hardware/Cable';
import { VirtualTimeScheduler, __setDefaultScheduler } from '@/events/Scheduler';

interface Shell { executeCommand(command: string): Promise<string> }

async function type(device: Shell, commands: readonly string[]): Promise<string[]> {
  const replies: string[] = [];
  for (const command of commands) replies.push(await device.executeCommand(command));
  return replies;
}

interface BgpRow { network: { toString(): string }; asPath: number[] }
const pathOf = (firewall: FortiGate): number[] | undefined =>
  (firewall as unknown as { getRouting(): { getBgp(): { getEngine(): { getBgpTable(): BgpRow[] } } } })
    .getRouting().getBgp().getEngine().getBgpTable()
    .find((row) => row.network.toString() === '172.16.0.0')?.asPath;

let clock: VirtualTimeScheduler;
beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

const aspathMap = (rule: readonly string[]) =>
  ['config router route-map', 'edit "shape"', 'config rule', 'edit 1', ...rule, 'next', 'end', 'next', 'end'];

async function pair(aNeighbour: readonly string[], aBefore: readonly string[], bNeighbour: readonly string[], bBefore: readonly string[]) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('port2')!, b.getPort('port2')!);
  await type(a, [...aBefore,
    'config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next', 'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65001', 'set router-id 1.1.1.1',
    'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'end',
    'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002', ...aNeighbour, 'next', 'end', 'end']);
  await type(b, [...bBefore,
    'config system interface', 'edit port2', 'set ip 10.9.0.2 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65002', 'set router-id 2.2.2.2',
    'config neighbor', 'edit "10.9.0.1"', 'set remote-as 65001', ...bNeighbour, 'next', 'end', 'end']);
  clock.advance(240_000);
  return { a, b };
}

describe('route-map set-aspath', () => {
  it('witness: without a route-map B learns the plain path', async () => {
    const { b } = await pair([], [], [], []);
    expect(pathOf(b)).toEqual([65001]);
  });

  it('outbound prepend repeats the AS ahead of the advertised path', async () => {
    const { b } = await pair(['set route-map-out "shape"'], aspathMap(['set set-aspath "65001 65001"']), [], []);
    expect(pathOf(b)).toEqual([65001, 65001, 65001]);
  });

  it('outbound replace swaps the path, the local AS still comes first', async () => {
    const { b } = await pair(['set route-map-out "shape"'], aspathMap(['set set-aspath "64999"', 'set set-aspath-action replace']), [], []);
    expect(pathOf(b)).toEqual([65001, 64999]);
  });

  it('inbound prepend lengthens the path stored in the Adj-RIB-In', async () => {
    const { b } = await pair([], [], ['set route-map-in "shape"'], aspathMap(['set set-aspath "65009 65009"']));
    expect(pathOf(b)).toEqual([65009, 65009, 65001]);
  });

  it('a non-numeric AS number is refused at commit', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const replies = await type(firewall, ['config router route-map', 'edit "x"', 'config rule', 'edit 1', 'set set-aspath "65001 abc"', 'next', 'end', 'next', 'end']);
    expect(replies.join('\n')).toMatch(/parse error|fail/i);
    const routing = (firewall as unknown as { getRouting(): { getRoutePolicies(): { get(name: string): unknown } } }).getRouting();
    expect(routing.getRoutePolicies().get('x')).toBeUndefined();
  });
});

/*
 * Probe: FortiOS 7.4.12 (router bgp, p.1067) documents `dampening`, `dampening-suppress` (default 2000), `dampening-reuse` (750),
 * `dampening-reachability-half-life` / `dampening-unreachability-half-life` (15 min) and `dampening-max-suppress-time` (60 min).
 * None existed, and a prefix that flapped was re-learned each time. The BGP engine now keeps a penalty per eBGP prefix and peer
 * (RFC 2439): 1000 per withdrawal (also when the session falls), 500 for an attribute change, exponential decay with the half-life,
 * suppression above the suppress limit, release at the reuse limit, and a ceiling of reuse x 2^(max-suppress / half-life) so no
 * route stays suppressed longer than the maximum. A suppressed route stays in the Adj-RIB-In but takes no part in best-path
 * selection, so it is neither installed nor advertised on.
 * `dampening-route-map` is refused: no route-map here carries the set-dampening values it selects.
 *
 * Two FortiGate are paired; A (AS 65001) withdraws and re-announces 172.16.0.0/16 repeatedly.
 * Discriminated with git stash on src/network: 4 of 6 fall before the change; the witness (dampening off) and the two-flap case
 * (penalty 2000 does not exceed the limit) pass either way.
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

interface BgpRow { network: { toString(): string } }
const holds = (firewall: FortiGate): boolean =>
  (firewall as unknown as { getRouting(): { getBgp(): { getEngine(): { getBgpTable(): BgpRow[] } } } })
    .getRouting().getBgp().getEngine().getBgpTable().some((row) => row.network.toString() === '172.16.0.0');

let clock: VirtualTimeScheduler;
beforeEach(() => {
  clock = new VirtualTimeScheduler();
  __setDefaultScheduler(clock);
});

async function pair(bSettings: readonly string[]) {
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
    'config router bgp', 'set as 65002', 'set router-id 2.2.2.2', ...bSettings,
    'config neighbor', 'edit "10.9.0.1"', 'set remote-as 65001', 'next', 'end', 'end']);
  clock.advance(240_000);
  return { a, b };
}

async function flap(a: FortiGate, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await type(a, ['config router bgp', 'config network', 'delete 1', 'end', 'end']);
    clock.advance(2_000);
    await type(a, ['config router bgp', 'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'end', 'end']);
    clock.advance(2_000);
  }
}

const minutes = (n: number) => n * 60_000;

describe('bgp route-flap dampening', () => {
  it('witness: without dampening a flapping route is learned again each time', async () => {
    const { a, b } = await pair([]);
    await flap(a, 5);
    expect(holds(b)).toBe(true);
  });

  it('two flaps stay under the default suppress limit', async () => {
    const { a, b } = await pair(['set dampening enable']);
    await flap(a, 2);
    expect(holds(b)).toBe(true);
  });

  it('three flaps pass the suppress limit and the route is withheld', async () => {
    const { a, b } = await pair(['set dampening enable']);
    await flap(a, 3);
    expect(holds(b)).toBe(false);
  });

  it('the penalty decays and the route is released at the reuse limit', async () => {
    const { a, b } = await pair(['set dampening enable']);
    await flap(a, 3);
    clock.advance(minutes(20));
    expect(holds(b)).toBe(false);
    clock.advance(minutes(15));
    expect(holds(b)).toBe(true);
  });

  it('dampening-max-suppress-time caps the suppression', async () => {
    const { a, b } = await pair(['set dampening enable', 'set dampening-max-suppress-time 30']);
    await flap(a, 8);
    expect(holds(b)).toBe(false);
    clock.advance(minutes(31));
    expect(holds(b)).toBe(true);
  });

  it('the settings are range checked and dampening-route-map is refused', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const replies = await type(firewall, ['config router bgp', 'set dampening-reuse 30000', 'set dampening-route-map "m"']);
    expect(replies[1]).toMatch(/out of range|range|fail/i);
    expect(replies[2]).toMatch(/set-dampening/);
  });
});

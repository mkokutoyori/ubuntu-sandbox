/*
 * Probe: FortiOS 7.4.12 (router bgp, p.1067) documents `graceful-restart`, `graceful-restart-time` (1-3600, default 120),
 * `graceful-stalepath-time` (1-3600, default 360) and `graceful-end-on-timer`. The schema carried none of them, and the BGP engine
 * dropped every learned route the moment a session fell. It now implements the receiving speaker of RFC 4724: the Graceful Restart
 * capability (restart time) travels in OPEN, the routes of a peer that advertised it are kept as stale when its session drops
 * without a NOTIFICATION received (§4.2), they still compete in best-path selection and are forwarded on, a re-announced prefix
 * replaces its stale copy, the End-of-RIB marker (an empty UPDATE, §2) purges what the restarted peer did not re-announce, and the
 * restart timer purges everything when the peer never returns.
 *
 * Two FortiGate are paired on a cable: A (AS 65001) advertises 172.16.0.0/16 to B (AS 65002); the link of A is then cut.
 * Discriminated with git stash on src/network: 5 of 6 fall before the change; the witness (graceful restart disabled: the route
 * leaves with the session) passes either way.
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

async function pair(graceful: boolean, bExtra: readonly string[] = []) {
  const a = new FortiGate('firewall-fortinet', 'A', 0, 0);
  const b = new FortiGate('firewall-fortinet', 'B', 200, 0);
  new Cable('ab').connect(a.getPort('port2')!, b.getPort('port2')!);
  const gr = graceful ? ['set graceful-restart enable', 'set graceful-restart-time 120', ...bExtra] : [];
  await type(a, [
    'config system interface', 'edit port1', 'set ip 172.16.0.1 255.255.0.0', 'next', 'edit port2', 'set ip 10.9.0.1 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65001', 'set router-id 1.1.1.1', ...(graceful ? ['set graceful-restart enable', 'set graceful-restart-time 120'] : []),
    'config network', 'edit 1', 'set prefix 172.16.0.0 255.255.0.0', 'next', 'end',
    'config neighbor', 'edit "10.9.0.2"', 'set remote-as 65002', 'next', 'end', 'end']);
  await type(b, [
    'config system interface', 'edit port2', 'set ip 10.9.0.2 255.255.255.0', 'next', 'end',
    'config router bgp', 'set as 65002', 'set router-id 2.2.2.2', ...gr,
    'config neighbor', 'edit "10.9.0.1"', 'set remote-as 65001', 'next', 'end', 'end']);
  clock.advance(240_000);
  return { a, b };
}

const cutA = (a: FortiGate) => type(a, ['config system interface', 'edit port2', 'set status down', 'next', 'end']);
const restoreA = (a: FortiGate) => type(a, ['config system interface', 'edit port2', 'set status up', 'next', 'end']);

describe('bgp graceful restart', () => {
  it('witness: without graceful restart the route leaves with the session', async () => {
    const { a, b } = await pair(false);
    expect(holds(b)).toBe(true);
    await cutA(a);
    clock.advance(200_000);
    expect(holds(b)).toBe(false);
  });

  it('the configuration is accepted, rendered and range checked', async () => {
    const firewall = new FortiGate('firewall-fortinet', 'FGT', 0, 0);
    const replies = await type(firewall, ['config router bgp', 'set as 65001', 'set graceful-restart enable', 'set graceful-restart-time 4000']);
    expect(replies[2]).toBe('');
    expect(replies[3]).toMatch(/out of range|range|fail/i);
    await type(firewall, ['set graceful-restart-time 90', 'set graceful-stalepath-time 200', 'end']);
    const shown = await firewall.executeCommand('show router bgp');
    expect(shown).toContain('set graceful-restart enable');
    expect(shown).toContain('set graceful-restart-time 90');
    expect(shown).toContain('set graceful-stalepath-time 200');
  });

  it('a dropped session keeps the learned route as stale while the restart time runs', async () => {
    const { a, b } = await pair(true);
    await cutA(a);
    clock.advance(200_000);
    expect(holds(b)).toBe(true);
  });

  it('the restart timer purges the stale route when the peer never returns', async () => {
    const { a, b } = await pair(true);
    await cutA(a);
    clock.advance(200_000);
    expect(holds(b)).toBe(true);
    clock.advance(400_000);
    expect(holds(b)).toBe(false);
  });

  it('a peer that comes back re-announces and End-of-RIB leaves nothing stale', async () => {
    const { a, b } = await pair(true);
    await cutA(a);
    clock.advance(200_000);
    expect(holds(b)).toBe(true);
    await type(a, ['config router bgp', 'config network', 'delete 1', 'end', 'end']);
    await restoreA(a);
    clock.advance(120_000);
    expect(holds(b)).toBe(false);
  });

  it('graceful-end-on-timer ignores End-of-RIB: the stale route stays until the stale-path timer', async () => {
    const { a, b } = await pair(true, ['set graceful-end-on-timer enable', 'set graceful-stalepath-time 300']);
    await cutA(a);
    clock.advance(200_000);
    await type(a, ['config router bgp', 'config network', 'delete 1', 'end', 'end']);
    await restoreA(a);
    clock.advance(120_000);
    expect(holds(b)).toBe(true);
    clock.advance(400_000);
    expect(holds(b)).toBe(false);
  });
});

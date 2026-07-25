/**
 * Autonomous OSPF reconvergence must actually reach the RIB (rapport 02
 * audit, item #36).
 *
 * Before this, `RouterOSPFIntegration.onPortDown` called
 * `ospfEngine.deactivateInterface()` (which only *schedules* SPF — a real
 * RFC 2328 §16.5 throttle timer, not a synchronous recompute) and then
 * immediately re-read `getRoutes()`, which still held the pre-outage
 * route list. The `ospf.routes-recomputed` event the SPF timer eventually
 * *did* publish had nowhere to go: `RoutingTableSyncActor` existed
 * specifically to forward it to an install callback, but nothing in
 * production ever registered one — only test code did. So a link going
 * down with no CLI command run afterward left the dead OSPF route sitting
 * in the RIB indefinitely, while the unrelated "connected route on the
 * severed link disappears" behavior (a separate mechanism) kept working
 * and masked the gap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.getInstance().clear();
});

afterEach(() => {
  vi.useRealTimers();
});

async function buildChain(): Promise<{ r1: CiscoRouter; r2: CiscoRouter }> {
  const r1 = new CiscoRouter('router-cisco', 'R1');
  const r2 = new CiscoRouter('router-cisco', 'R2');

  await r1.executeCommand('enable');
  await r1.executeCommand('configure terminal');
  await r1.executeCommand('interface GigabitEthernet0/0');
  await r1.executeCommand('ip address 10.0.12.1 255.255.255.252');
  await r1.executeCommand('no shutdown');
  await r1.executeCommand('exit');
  await r1.executeCommand('router ospf 1');
  await r1.executeCommand('network 10.0.12.0 0.0.0.3 area 0');
  await r1.executeCommand('end');

  await r2.executeCommand('enable');
  await r2.executeCommand('configure terminal');
  await r2.executeCommand('interface GigabitEthernet0/0');
  await r2.executeCommand('ip address 10.0.12.2 255.255.255.252');
  await r2.executeCommand('no shutdown');
  await r2.executeCommand('exit');
  await r2.executeCommand('interface Loopback1');
  await r2.executeCommand('ip address 192.168.20.1 255.255.255.0');
  await r2.executeCommand('exit');
  await r2.executeCommand('router ospf 1');
  await r2.executeCommand('network 10.0.12.0 0.0.0.3 area 0');
  await r2.executeCommand('network 192.168.20.0 0.0.0.255 area 0');
  await r2.executeCommand('end');

  new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

  return { r1, r2 };
}

describe('OSPF learns a remote route, then withdraws it autonomously on link failure', () => {
  it('R1 learns 192.168.20.0/24 (an OSPF route, not connected) via R2', async () => {
    const { r1 } = await buildChain();
    const route = await r1.executeCommand('show ip route');
    expect(route).toMatch(/^O\s+192\.168\.20\.0\/24 \[110\/\d+\] via 10\.0\.12\.2/m);
  });

  it('bringing R1\'s own interface down with NO CLI command withdraws the OSPF route once the SPF throttle timer fires', async () => {
    const { r1 } = await buildChain();
    const hasOspfRouteToLoopback = () =>
      r1.getRoutingTable().some(
        (r) => r.type === 'ospf' && r.network.toString() === '192.168.20.0',
      );
    expect(hasOspfRouteToLoopback()).toBe(true);

    vi.useFakeTimers();
    r1.getPort('GigabitEthernet0/0')!.setUp(false);
    await vi.advanceTimersByTimeAsync(1_000);
    vi.useRealTimers();

    // Checked against the raw RIB storage (getRoutingTable()), not
    // `show ip route` — that CLI view already masks routes over a
    // carrier-less interface for display/forwarding purposes
    // (Router.ts's isRouteInterfaceUsable), which would make this
    // assertion pass even when the stale entry was never actually
    // removed from the table.
    expect(hasOspfRouteToLoopback()).toBe(false);
  });
});

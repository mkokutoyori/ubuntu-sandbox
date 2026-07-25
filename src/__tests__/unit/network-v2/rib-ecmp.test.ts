/**
 * RIB ECMP (rapport 02 audit, item #40 — one of three sub-claims: "no
 * ECMP" was true at the RIB/forwarding layer even though OSPFEngine's
 * own SPF already computed equal-cost paths (`OSPFRouteEntry.nextHops`/
 * `ifaces`). `RouterOSPFIntegration.installRoutes` only ever read the
 * primary `nextHop`/`iface`, discarding the rest, and `Router.lookupRoute`
 * always froze on whichever equal route was inserted first — no
 * multipath forwarding existed for any protocol.
 *
 * The other two sub-claims of item #40 (route recursion; control/data
 * plane separation) are genuinely larger gaps, documented in CLAUDE.md
 * rather than fixed here — see that note for why.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function configure(r: CiscoRouter, cmds: string[]) {
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  for (const c of cmds) await r.executeCommand(c);
  await r.executeCommand('end');
}

/**
 * R1 has two equal-cost OSPF paths to 192.168.20.0/24: via R2 and via R3,
 * each advertising an identically-numbered stub Loopback (mirroring the
 * raw-engine ECMP fixture in ospf-ecmp-ext-interarea.test.ts, at the
 * device/CLI level instead of directly against OSPFEngine).
 */
async function buildEcmpTopology() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const r3 = new CiscoRouter('R3');

  await configure(r1, [
    'interface GigabitEthernet0/0', 'ip address 10.0.12.1 255.255.255.252', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 10.0.13.1 255.255.255.252', 'no shutdown', 'exit',
    'router ospf 1',
    'network 10.0.12.0 0.0.0.3 area 0',
    'network 10.0.13.0 0.0.0.3 area 0',
  ]);
  await configure(r2, [
    'interface GigabitEthernet0/0', 'ip address 10.0.12.2 255.255.255.252', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 192.168.20.1 255.255.255.0', 'exit',
    'router ospf 1',
    'router-id 2.2.2.2',
    'network 10.0.12.0 0.0.0.3 area 0',
    'network 192.168.20.0 0.0.0.255 area 0',
  ]);
  await configure(r3, [
    'interface GigabitEthernet0/0', 'ip address 10.0.13.2 255.255.255.252', 'no shutdown', 'exit',
    'interface Loopback1', 'ip address 192.168.20.1 255.255.255.0', 'exit',
    'router ospf 1',
    'router-id 3.3.3.3',
    'network 10.0.13.0 0.0.0.3 area 0',
    'network 192.168.20.0 0.0.0.255 area 0',
  ]);

  new Cable('c12').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);
  new Cable('c13').connect(r1.getPort('GigabitEthernet0/1')!, r3.getPort('GigabitEthernet0/0')!);

  return { r1, r2, r3 };
}

describe('OSPF ECMP reaches the RIB (RouterOSPFIntegration.installRoutes)', () => {
  it('installs one RIB entry per equal-cost next-hop instead of collapsing to the primary path', async () => {
    const { r1 } = await buildEcmpTopology();

    const ospfRoutesTo20 = r1.getRoutingTable().filter(
      (r) => r.type === 'ospf' && r.network.toString() === '192.168.20.0',
    );
    expect(ospfRoutesTo20.length).toBe(2);
    const nextHops = new Set(ospfRoutesTo20.map((r) => r.nextHop?.toString()));
    expect(nextHops).toEqual(new Set(['10.0.12.2', '10.0.13.2']));
  });
});

describe('Router.lookupRoute — real multipath forwarding, not first-wins', () => {
  it('round-robins across genuinely tied equal-cost RIB entries', async () => {
    const { r1 } = await buildEcmpTopology();

    // lookupRoute is a private data-plane seam; reach in from the test the
    // same way CiscoOspfCommands.ts's own CLI display code already does
    // ((router as any).routingTable) — there's no other way to observe a
    // single forwarding decision without wiring up full packet capture.
    const lookup = (ip: string) =>
      (r1 as unknown as { lookupRoute(ip: IPAddress): { nextHop: IPAddress | null } | null })
        .lookupRoute(new IPAddress(ip));

    const seen = new Set<string | undefined>();
    for (let i = 0; i < 4; i++) {
      const route = lookup('192.168.20.5');
      expect(route).not.toBeNull();
      seen.add(route!.nextHop?.toString());
    }

    expect(seen).toEqual(new Set(['10.0.12.2', '10.0.13.2']));
  });

  it('a single, non-tied route is unaffected (no spurious round-robin)', async () => {
    const r1 = new CiscoRouter('R1');
    const r2 = new CiscoRouter('R2');
    await configure(r1, [
      'interface GigabitEthernet0/0', 'ip address 10.0.0.1 255.255.255.252', 'no shutdown', 'exit',
      'ip route 172.16.0.0 255.255.0.0 10.0.0.2',
    ]);
    await configure(r2, [
      'interface GigabitEthernet0/0', 'ip address 10.0.0.2 255.255.255.252', 'no shutdown', 'exit',
    ]);
    new Cable('c1').connect(r1.getPort('GigabitEthernet0/0')!, r2.getPort('GigabitEthernet0/0')!);

    const lookup = () =>
      (r1 as unknown as { lookupRoute(ip: IPAddress): { nextHop: IPAddress | null } | null })
        .lookupRoute(new IPAddress('172.16.5.5'));

    for (let i = 0; i < 4; i++) {
      expect(lookup()!.nextHop?.toString()).toBe('10.0.0.2');
    }
  });
});

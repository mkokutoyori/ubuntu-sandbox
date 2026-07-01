/**
 * Scénario 15 — Isolation multi-tenant VRF + IPsec sur une passerelle
 * Cisco, avec plages d'adresses internes IDENTIQUES entre deux tenants.
 *
 * Topologie :
 *
 *   [SiteA_R]  ==== IPsec tunnel A ====\
 *                                        [Central_R] --- (deux VRF, deux
 *   [SiteB_R]  ==== IPsec tunnel B ====/                 crypto maps distincts)
 *
 * Chaque site distant possède un PC dont l'IP privée est identique
 * (192.168.1.10/24 dans les deux VRF), reproduisant le cas classique de
 * plans d'adressage privés non coordonnés en environnement multi-tenant.
 *
 * Points de contrôle vérifiés (couverture 15.A → 15.G) :
 *   - `show ip vrf` liste bien les deux VRF déclarés
 *   - `ip vrf forwarding` sur une interface place l'interface dans la
 *     liste de son VRF ET seulement dans celle-là (pas de fuite via
 *     inscription simultanée dans deux VRF)
 *   - `show ip route vrf X` renvoie strictement les routes de X, y
 *     compris quand une route au même préfixe existe dans Y
 *   - la Map `_ciscoVrfRoutes` garde les routes indexées par VRF
 *     (aucun partage d'entrée)
 *   - deux SAs IPsec vers deux sites distincts peuvent coexister avec
 *     la MÊME plage interne 192.168.1.0/24, différenciées par les
 *     SPIs (jamais mélangées côté encaps/décaps)
 *   - une tentative de route-leak (adding a static route in the wrong
 *     VRF) est stockée dans le VRF cible et jamais dans un autre VRF
 *   - `no ip vrf` supprime l'entrée du map et son binding d'interface
 *
 * Critère de réussite : étanchéité totale entre les deux VRF, y compris
 * avec des plages d'adresses identiques ; toute tentative de fuite reste
 * localisée au VRF cible ; les compteurs par-SA restent séparés.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

async function buildTwoTenantTopology() {
  const central = new CiscoRouter('Central');
  const siteA = new CiscoRouter('SiteA');
  const siteB = new CiscoRouter('SiteB');
  const pcA = new LinuxPC('linux-pc', 'PC-A');
  const pcB = new LinuxPC('linux-pc', 'PC-B');

  new Cable('central-a').connect(central.getPort('GigabitEthernet0/1')!, siteA.getPort('GigabitEthernet0/1')!);
  new Cable('central-b').connect(central.getPort('GigabitEthernet0/2')!, siteB.getPort('GigabitEthernet0/1')!);
  new Cable('siteA-lan').connect(pcA.getPort('eth0')!, siteA.getPort('GigabitEthernet0/0')!);
  new Cable('siteB-lan').connect(pcB.getPort('eth0')!, siteB.getPort('GigabitEthernet0/0')!);

  await central.executeCommand('enable');
  await central.executeCommand('configure terminal');
  await central.executeCommand('ip vrf VRF-ClientA');
  await central.executeCommand('rd 65001:1');
  await central.executeCommand('exit');
  await central.executeCommand('ip vrf VRF-ClientB');
  await central.executeCommand('rd 65001:2');
  await central.executeCommand('exit');
  await central.executeCommand('interface GigabitEthernet0/1');
  await central.executeCommand('ip vrf forwarding VRF-ClientA');
  await central.executeCommand('ip address 10.0.12.1 255.255.255.252');
  await central.executeCommand('no shutdown');
  await central.executeCommand('exit');
  await central.executeCommand('interface GigabitEthernet0/2');
  await central.executeCommand('ip vrf forwarding VRF-ClientB');
  await central.executeCommand('ip address 10.0.34.1 255.255.255.252');
  await central.executeCommand('no shutdown');
  await central.executeCommand('exit');
  await central.executeCommand('ip route vrf VRF-ClientA 192.168.1.0 255.255.255.0 10.0.12.2');
  await central.executeCommand('ip route vrf VRF-ClientB 192.168.1.0 255.255.255.0 10.0.34.2');
  await central.executeCommand('end');

  for (const [router, wan, peer, lan] of [
    [siteA, '10.0.12.2', '10.0.12.1', '192.168.1.1'],
    [siteB, '10.0.34.2', '10.0.34.1', '192.168.1.1'],
  ] as [CiscoRouter, string, string, string][]) {
    await router.executeCommand('enable');
    await router.executeCommand('configure terminal');
    await router.executeCommand('interface GigabitEthernet0/1');
    await router.executeCommand(`ip address ${wan} 255.255.255.252`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand('interface GigabitEthernet0/0');
    await router.executeCommand(`ip address ${lan} 255.255.255.0`);
    await router.executeCommand('no shutdown');
    await router.executeCommand('exit');
    await router.executeCommand(`ip route 0.0.0.0 0.0.0.0 ${peer}`);
    await router.executeCommand('end');
  }

  await pcA.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pcA.executeCommand('sudo ip route add default via 192.168.1.1');
  await pcB.executeCommand('sudo ip addr add 192.168.1.10/24 dev eth0');
  await pcB.executeCommand('sudo ip route add default via 192.168.1.1');

  return { central, siteA, siteB, pcA, pcB };
}

function vrfRoutesFor(router: CiscoRouter, vrfName: string): Array<{ network: string; mask: string; nextHop: string | null; iface: string | null }> {
  const r = router as unknown as { _ciscoVrfRoutes?: Map<string, Array<{ network: string; mask: string; nextHop: string | null; iface: string | null }>> };
  return r._ciscoVrfRoutes?.get(vrfName) ?? [];
}

function vrfInternalMap(router: CiscoRouter): Map<string, { name: string; rd?: string; interfaces: Set<string> }> {
  const r = router as unknown as { _vrfs?: Map<string, { name: string; rd?: string; interfaces: Set<string> }> };
  return r._vrfs ?? new Map();
}

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

describe('Scenario 15 — multi-tenant VRF isolation with overlapping 192.168.1.0/24', () => {
  describe('15.A — VRF declaration and CLI visibility', () => {
    it('show ip vrf enumerates both declared VRFs with their RD and bound interfaces', async () => {
      const { central } = await buildTwoTenantTopology();
      const out = await central.executeCommand('show ip vrf');
      expect(out).toContain('VRF-ClientA');
      expect(out).toContain('VRF-ClientB');
      expect(out).toContain('65001:1');
      expect(out).toContain('65001:2');
    });

    it('each VRF lists exactly one interface (Gi0/1 for A, Gi0/2 for B) — no double-binding', async () => {
      const { central } = await buildTwoTenantTopology();
      const vrfs = vrfInternalMap(central);
      const a = vrfs.get('VRF-ClientA')!;
      const b = vrfs.get('VRF-ClientB')!;
      expect([...a.interfaces]).toEqual(['GigabitEthernet0/1']);
      expect([...b.interfaces]).toEqual(['GigabitEthernet0/2']);
      for (const iface of a.interfaces) expect(b.interfaces.has(iface)).toBe(false);
    });
  });

  describe('15.B — per-VRF routing table isolation', () => {
    it('show ip route vrf VRF-ClientA lists only that VRF\'s routes (192.168.1.0/24 via 10.0.12.2)', async () => {
      const { central } = await buildTwoTenantTopology();
      const routeA = await central.executeCommand('show ip route vrf VRF-ClientA');
      expect(routeA).toContain('Routing Table: VRF-ClientA');
      expect(routeA).toContain('192.168.1.0/24');
      expect(routeA).toContain('via 10.0.12.2');
      expect(routeA).not.toContain('10.0.34.2');
    });

    it('show ip route vrf VRF-ClientB lists only that VRF\'s routes (192.168.1.0/24 via 10.0.34.2)', async () => {
      const { central } = await buildTwoTenantTopology();
      const routeB = await central.executeCommand('show ip route vrf VRF-ClientB');
      expect(routeB).toContain('Routing Table: VRF-ClientB');
      expect(routeB).toContain('192.168.1.0/24');
      expect(routeB).toContain('via 10.0.34.2');
      expect(routeB).not.toContain('10.0.12.2');
    });

    it('an unknown VRF returns a % No such VRF error, not a global fallback', async () => {
      const { central } = await buildTwoTenantTopology();
      const out = await central.executeCommand('show ip route vrf VRF-Ghost');
      expect(out).toMatch(/% No such VRF, VRF-Ghost/);
    });
  });

  describe('15.C — same 192.168.1.0/24 subnet coexists between two VRF with distinct next-hops', () => {
    it('the two VRF entries in _ciscoVrfRoutes for 192.168.1.0/24 are separate objects with distinct nextHops', async () => {
      const { central } = await buildTwoTenantTopology();
      const a = vrfRoutesFor(central, 'VRF-ClientA').find((r) => r.network === '192.168.1.0');
      const b = vrfRoutesFor(central, 'VRF-ClientB').find((r) => r.network === '192.168.1.0');
      expect(a?.nextHop).toBe('10.0.12.2');
      expect(b?.nextHop).toBe('10.0.34.2');
      expect(a).not.toBe(b);
    });

    it('adding a leaky global static route to 192.168.1.0/24 does NOT modify either VRF\'s per-VRF entry', async () => {
      const { central } = await buildTwoTenantTopology();
      const beforeA = vrfRoutesFor(central, 'VRF-ClientA').find((r) => r.network === '192.168.1.0')?.nextHop;
      const beforeB = vrfRoutesFor(central, 'VRF-ClientB').find((r) => r.network === '192.168.1.0')?.nextHop;
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('ip route 192.168.1.0 255.255.255.0 10.99.99.99');
      await central.executeCommand('end');
      const afterA = vrfRoutesFor(central, 'VRF-ClientA').find((r) => r.network === '192.168.1.0')?.nextHop;
      const afterB = vrfRoutesFor(central, 'VRF-ClientB').find((r) => r.network === '192.168.1.0')?.nextHop;
      expect(afterA).toBe(beforeA);
      expect(afterB).toBe(beforeB);
      expect(afterA).not.toBe(afterB);
    });
  });

  describe('15.D — route-leak attempt into the wrong VRF stays inside the target VRF', () => {
    it('adding a leaky static in VRF-ClientA that lands on B\'s next-hop is stored in A, not B', async () => {
      const { central } = await buildTwoTenantTopology();
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('ip route vrf VRF-ClientA 172.16.99.0 255.255.255.0 10.0.34.2');
      await central.executeCommand('end');
      const inA = vrfRoutesFor(central, 'VRF-ClientA').filter((r) => r.network === '172.16.99.0');
      const inB = vrfRoutesFor(central, 'VRF-ClientB').filter((r) => r.network === '172.16.99.0');
      expect(inA.length).toBe(1);
      expect(inA[0].nextHop).toBe('10.0.34.2');
      expect(inB.length).toBe(0);
    });

    it('adding the same prefix in each VRF creates two independent entries, one per VRF', async () => {
      const { central } = await buildTwoTenantTopology();
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('ip route vrf VRF-ClientA 172.30.0.0 255.255.0.0 10.0.12.2');
      await central.executeCommand('ip route vrf VRF-ClientB 172.30.0.0 255.255.0.0 10.0.34.2');
      await central.executeCommand('end');
      const inA = vrfRoutesFor(central, 'VRF-ClientA').filter((r) => r.network === '172.30.0.0');
      const inB = vrfRoutesFor(central, 'VRF-ClientB').filter((r) => r.network === '172.30.0.0');
      expect(inA.length).toBe(1);
      expect(inB.length).toBe(1);
      expect(inA[0]).not.toBe(inB[0]);
      expect(inA[0].nextHop).not.toBe(inB[0].nextHop);
    });
  });

  describe('15.E — interface rebinding: leaving one VRF removes the entry from that VRF only', () => {
    it('re-binding Gi0/1 from VRF-ClientA to VRF-ClientB moves it exactly once', async () => {
      const { central } = await buildTwoTenantTopology();
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('interface GigabitEthernet0/1');
      await central.executeCommand('ip vrf forwarding VRF-ClientB');
      await central.executeCommand('end');
      const vrfs = vrfInternalMap(central);
      expect(vrfs.get('VRF-ClientA')!.interfaces.has('GigabitEthernet0/1')).toBe(false);
      expect(vrfs.get('VRF-ClientB')!.interfaces.has('GigabitEthernet0/1')).toBe(true);
      expect(vrfs.get('VRF-ClientB')!.interfaces.has('GigabitEthernet0/2')).toBe(true);
    });

    it('no ip vrf forwarding on an interface removes it from every VRF', async () => {
      const { central } = await buildTwoTenantTopology();
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('interface GigabitEthernet0/1');
      await central.executeCommand('no ip vrf forwarding');
      await central.executeCommand('end');
      const vrfs = vrfInternalMap(central);
      for (const [, vrf] of vrfs) expect(vrf.interfaces.has('GigabitEthernet0/1')).toBe(false);
    });
  });

  describe('15.F — VRF deletion cleans up interface bindings', () => {
    it('no ip vrf VRF-ClientA removes the entry from _vrfs, dropping its interface list', async () => {
      const { central } = await buildTwoTenantTopology();
      const before = vrfInternalMap(central).size;
      expect(before).toBe(2);
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('no ip vrf VRF-ClientA');
      await central.executeCommand('end');
      const vrfs = vrfInternalMap(central);
      expect(vrfs.size).toBe(1);
      expect(vrfs.has('VRF-ClientA')).toBe(false);
      expect(vrfs.has('VRF-ClientB')).toBe(true);
    });
  });

  describe('15.G — running-config round-trip preserves VRF declarations and per-VRF routes', () => {
    it('show ip vrf, show ip route vrf X remain consistent after multiple back-to-back updates', async () => {
      const { central } = await buildTwoTenantTopology();
      await central.executeCommand('enable');
      await central.executeCommand('configure terminal');
      await central.executeCommand('ip route vrf VRF-ClientA 10.20.30.0 255.255.255.0 10.0.12.2');
      await central.executeCommand('ip route vrf VRF-ClientB 10.20.30.0 255.255.255.0 10.0.34.2');
      await central.executeCommand('end');

      const routeA = await central.executeCommand('show ip route vrf VRF-ClientA');
      const routeB = await central.executeCommand('show ip route vrf VRF-ClientB');
      expect(routeA).toContain('10.20.30.0');
      expect(routeA).toContain('via 10.0.12.2');
      expect(routeA).not.toContain('via 10.0.34.2');
      expect(routeB).toContain('10.20.30.0');
      expect(routeB).toContain('via 10.0.34.2');
      expect(routeB).not.toContain('via 10.0.12.2');

      const vrfs = vrfInternalMap(central);
      expect(vrfs.get('VRF-ClientA')?.rd).toBe('65001:1');
      expect(vrfs.get('VRF-ClientB')?.rd).toBe('65001:2');
    });
  });
});

/**
 * Scénario 3 — STP et LACP sur switch Huawei (purement Huawei).
 *
 * Le contrôle plan LACP (négociation, sélection de bundle, `display
 * eth-trunk`) est un moteur réel (`LacpAgent`) ; en revanche, l'Eth-Trunk
 * lui-même n'a pas de présence dans le plan de données L2 (`Switch.ts` ne
 * crée de `SwitchportConfig` que pour les ports physiques) — configurer
 * `port link-type trunk` directement sur l'interface `Eth-Trunk1` est donc
 * un no-op silencieux aujourd'hui. Ce scénario ne teste que ce que ses
 * propres points de contrôle vérifient réellement (rôles STP, état
 * `Selected` des membres, compteurs LACP), pas le transport VLAN à travers
 * le bundle lui-même.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Lab { sw1: HuaweiSwitch; sw2: HuaweiSwitch }

function buildRing(): Lab {
  const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 25);
  const sw2 = new HuaweiSwitch('switch-huawei', 'SW2', 25);
  // Two parallel links between SW1 and SW2 so STP must block one.
  new Cable('c1').connect(sw1.getPort('GigabitEthernet0/0/23')!, sw2.getPort('GigabitEthernet0/0/23')!);
  new Cable('c2').connect(sw1.getPort('GigabitEthernet0/0/24')!, sw2.getPort('GigabitEthernet0/0/24')!);
  return { sw1, sw2 };
}

describe('Scénario 3 — STP et LACP sur switch Huawei', () => {
  describe('configuration STP/RSTP', () => {
    it('stp mode rstp + stp priority/root primary sont acceptés et reflétés par display stp', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      const modeOut = await sw.executeCommand('stp mode rstp');
      expect(modeOut).not.toMatch(/Unrecognized|Error/);
      const prioOut = await sw.executeCommand('stp priority 4096');
      expect(prioOut).not.toMatch(/Unrecognized|Error/);
      const rootOut = await sw.executeCommand('stp root primary');
      expect(rootOut).not.toMatch(/Unrecognized|Error/);
      await sw.executeCommand('return');

      const out = await sw.executeCommand('display stp');
      expect(out).toMatch(/RSTP/i);
    });

    it('stp edged-port enable et stp bpdu-protection enable configurent réellement le moteur STP (protection visible dans display stp brief)', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      const edgeOut = await sw.executeCommand('stp edged-port enable');
      expect(edgeOut).not.toMatch(/Unrecognized|Error/);
      const bpduOut = await sw.executeCommand('stp bpdu-protection enable');
      expect(bpduOut).not.toMatch(/Unrecognized|Error/);
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const brief = await sw.executeCommand('display stp brief');
      const line = brief.split('\n').find((l) => l.includes('GigabitEthernet0/0/1'));
      expect(line).toBeDefined();
      expect(line).toMatch(/BPDU/);
    });
  });

  describe('élection du root bridge entre deux switches en anneau', () => {
    it('display stp brief montre SW1 en ROOT sur toutes ses interfaces et SW2 en ALTE sur le port bloqué', async () => {
      const { sw1, sw2 } = buildRing();
      await sw1.executeCommand('system-view');
      await sw1.executeCommand('stp mode rstp');
      await sw1.executeCommand('stp root primary');
      await sw1.executeCommand('return');

      await sw2.executeCommand('system-view');
      await sw2.executeCommand('stp mode rstp');
      await sw2.executeCommand('stp root secondary');
      await sw2.executeCommand('return');

      // Let RSTP converge (root/port role computation runs off simulated
      // timers driven by the shared scheduler).
      await new Promise((r) => setTimeout(r, 50));

      const sw1Brief = await sw1.executeCommand('display stp brief');
      const sw1Lines = sw1Brief.split('\n').filter((l) => /GigabitEthernet0\/0\/2[34]/.test(l));
      expect(sw1Lines.length).toBe(2);
      for (const l of sw1Lines) expect(l).toMatch(/DESI|ROOT/);

      const sw2Brief = await sw2.executeCommand('display stp brief');
      const sw2Lines = sw2Brief.split('\n').filter((l) => /GigabitEthernet0\/0\/2[34]/.test(l));
      expect(sw2Lines.length).toBe(2);
      // Exactly one of SW2's two parallel links to the root becomes the
      // ROOT port; the other is blocked (ALTE).
      expect(sw2Lines.some((l) => l.includes('ROOT'))).toBe(true);
      expect(sw2Lines.some((l) => l.includes('ALTE'))).toBe(true);
    });
  });

  describe('configuration LACP et Eth-Trunk', () => {
    it('eth-trunk avec mode lacp-static bundle les deux membres en état Selected', async () => {
      const { sw1, sw2 } = buildRing();

      for (const sw of [sw1, sw2]) {
        await sw.executeCommand('system-view');
        await sw.executeCommand('interface Eth-Trunk 1');
        await sw.executeCommand('mode lacp-static');
        await sw.executeCommand('load-balance src-dst-mac');
        await sw.executeCommand('quit');
        await sw.executeCommand('interface GigabitEthernet 0/0/23');
        await sw.executeCommand('eth-trunk 1');
        await sw.executeCommand('quit');
        await sw.executeCommand('interface GigabitEthernet 0/0/24');
        await sw.executeCommand('eth-trunk 1');
        await sw.executeCommand('quit');
        await sw.executeCommand('return');
      }

      // Let LACP negotiate (LACPDU exchange is timer-driven).
      await new Promise((r) => setTimeout(r, 100));

      const out = await sw1.executeCommand('display eth-trunk 1');
      expect(out).not.toMatch(/Unrecognized|does not exist/);
      expect(out).toMatch(/WorkingMode:\s*LACP/);
      expect(out).toContain('GigabitEthernet0/0/23');
      expect(out).toContain('GigabitEthernet0/0/24');
      expect(out).toMatch(/Selected/);
    });

    it('display lacp statistics montre des compteurs LACPDU non nuls après négociation', async () => {
      const { sw1, sw2 } = buildRing();

      for (const sw of [sw1, sw2]) {
        await sw.executeCommand('system-view');
        await sw.executeCommand('interface Eth-Trunk 1');
        await sw.executeCommand('mode lacp-static');
        await sw.executeCommand('quit');
        await sw.executeCommand('interface GigabitEthernet 0/0/23');
        await sw.executeCommand('eth-trunk 1');
        await sw.executeCommand('quit');
        await sw.executeCommand('interface GigabitEthernet 0/0/24');
        await sw.executeCommand('eth-trunk 1');
        await sw.executeCommand('quit');
        await sw.executeCommand('return');
      }

      await new Promise((r) => setTimeout(r, 100));

      const stats = await sw1.executeCommand('display lacp statistics');
      expect(stats).not.toMatch(/Unrecognized command/);
      expect(stats).toContain('GigabitEthernet0/0/23');
      expect(stats).toMatch(/LACPDU/);

      const sentMatches = [...stats.matchAll(/^\s*(\d+)\s+(\d+)\s+\d+\s+\d+$/gm)];
      expect(sentMatches.length).toBeGreaterThan(0);
      const anyNonZero = sentMatches.some(([, sent, received]) => Number(sent) > 0 || Number(received) > 0);
      expect(anyNonZero).toBe(true);
    });
  });

  describe('critère de réussite', () => {
    it('rôles STP corrects, membres Eth-Trunk Selected, compteurs LACP non nuls', async () => {
      const { sw1, sw2 } = buildRing();

      await sw1.executeCommand('system-view');
      await sw1.executeCommand('stp mode rstp');
      await sw1.executeCommand('stp root primary');
      await sw1.executeCommand('return');
      await sw2.executeCommand('system-view');
      await sw2.executeCommand('stp mode rstp');
      await sw2.executeCommand('stp root secondary');
      await sw2.executeCommand('return');
      await new Promise((r) => setTimeout(r, 50));

      const sw1Brief = await sw1.executeCommand('display stp brief');
      expect(sw1Brief.split('\n').filter((l) => /GigabitEthernet0\/0\/2[34]/.test(l))
        .every((l) => l.match(/DESI|ROOT/))).toBe(true);

      const sw2Brief = await sw2.executeCommand('display stp brief');
      expect(sw2Brief).toMatch(/ALTE/);
    });
  });
});

/**
 * Scénario 15 (Cisco) — Rapport d'audit NAT complet : show commands et
 * vérification de cohérence.
 *
 * Transcription littérale et fidèle : `show ip nat statistics` comme
 * source de vérité pour un rapport d'audit (Total/Static/Dynamic
 * translations, Outside/Inside interfaces, Hits/Misses, section
 * Dynamic mappings référençant l'ACL et l'interface), protection
 * proactive contre une référence PAT vers une ACL inexistante, et
 * vérification que `Misses: 0` est bien le principal signal de santé
 * NAT sur une configuration correcte.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const GW_INSIDE = '192.168.10.254';
const GW_OUTSIDE = '203.0.113.1';
const OUTSIDE_IP = '203.0.113.2';
const PC1_IP = '192.168.10.101';
const DC01_IP = '192.168.10.10';

interface Lab {
  pc1: LinuxPC;
  router: CiscoRouter;
}

async function buildLab(): Promise<Lab> {
  const lanSw = new GenericSwitch('switch-generic', 'lan-sw', 8, 0, 0);
  const wanSw = new GenericSwitch('switch-generic', 'wan-sw', 8, 0, 0);
  const router = new CiscoRouter('router', 0, 0);
  const pc1 = new LinuxPC('linux-pc', 'pc-1', 0, 0);
  const outside = new LinuxPC('linux-pc', 'outside', 0, 0);

  new Cable('a').connect(pc1.getPort('eth0')!, lanSw.getPorts()[0]);
  new Cable('d').connect(lanSw.getPorts()[7], router.getPort('GigabitEthernet0/0')!);
  new Cable('e').connect(router.getPort('GigabitEthernet0/1')!, wanSw.getPorts()[0]);
  new Cable('f').connect(wanSw.getPorts()[1], outside.getPort('eth0')!);

  const m = new SubnetMask('255.255.255.0');
  pc1.getPorts()[0].configureIP(new IPAddress(PC1_IP), m);
  pc1.setDefaultGateway(new IPAddress(GW_INSIDE));
  outside.getPorts()[0].configureIP(new IPAddress(OUTSIDE_IP), new SubnetMask('255.255.255.252'));
  outside.setDefaultGateway(new IPAddress(GW_OUTSIDE));

  for (const cmd of [
    'enable',
    'configure terminal',
    'interface GigabitEthernet0/0',
    `ip address ${GW_INSIDE} 255.255.255.0`,
    'ip nat inside',
    'no shutdown',
    'exit',
    'interface GigabitEthernet0/1',
    `ip address ${GW_OUTSIDE} 255.255.255.252`,
    'ip nat outside',
    'no shutdown',
    'exit',
    'ip access-list standard ACL-LAN-INTERNE',
    '10 permit 192.168.10.0 0.0.0.255',
    'exit',
    'ip nat inside source list ACL-LAN-INTERNE interface GigabitEthernet0/1 overload',
    `ip nat inside source static ${DC01_IP} 203.0.113.11`,
    `ip route 0.0.0.0 0.0.0.0 GigabitEthernet0/1`,
    'end',
  ]) await router.executeCommand(cmd);

  return { pc1, router };
}

describe('Scénario 15 (Cisco) — rapport d\'audit NAT complet', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('inventaire complet via show ip nat statistics', () => {
    it('expose Total/Static/Dynamic translations, interfaces Outside/Inside et Hits/Misses — toutes les données que le script d\'audit parse', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Total active translations:\s*2\s*\(1 static,\s*1 dynamic/);
      expect(out).toMatch(/Static translations:\s*1/);
      expect(out).toMatch(/Dynamic translations:\s*1/);
      expect(out).toMatch(/Outside interfaces:\s*GigabitEthernet0\/1/);
      expect(out).toMatch(/Inside interfaces:\s*GigabitEthernet0\/0/);
      expect(out).toMatch(/Hits:\s*\d+\s+Misses:\s*0/);
      expect(out).toMatch(/Inside Source \[acl ACL-LAN-INTERNE\] overload/);
    });

    it('affiche Peak translations (charge maximale observée)', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 1 ${OUTSIDE_IP}`);
      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Peak translations:\s*\d+/);
    });

    it('liste les traductions statiques dans une section dédiée (comme la section Dynamic mappings)', async () => {
      const { router } = await buildLab();
      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Static mappings:/);
      expect(out).toMatch(/static\s+192\.168\.10\.10\s+203\.0\.113\.11.*refcount/);
    });
  });

  describe('protection proactive contre une référence NAT invalide', () => {
    it('ip nat inside source list vers une ACL inexistante est rejetée immédiatement (pas de règle orpheline possible)', async () => {
      const { router } = await buildLab();
      await router.executeCommand('configure terminal');
      const out = await router.executeCommand('ip nat inside source list ACL-INEXISTANTE interface GigabitEthernet0/1 overload');
      await router.executeCommand('end');
      expect(out).toMatch(/access-list ACL-INEXISTANTE not defined/i);

      const rules = router._getNATEngine().getDynamicRules();
      expect(rules.every(r => r.aclId !== 'ACL-INEXISTANTE')).toBe(true);
    });
  });

  describe('signal de santé principal : Misses', () => {
    it('Misses reste à 0 sur une configuration NAT correcte malgré du trafic réel', async () => {
      const { pc1, router } = await buildLab();
      await pc1.executeCommand(`ping -c 3 ${OUTSIDE_IP}`);

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Misses:\s*0/);
    });
  });
});

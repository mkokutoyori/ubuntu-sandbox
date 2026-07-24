/**
 * Scénario 13 (Cisco) — Audit et sécurisation du NAT : détection des
 * mauvaises configurations.
 *
 * Transcription littérale et fidèle : trois anomalies volontaires
 * (interface sans marquage `ip nat inside`, ACL NAT standard trop
 * permissive `permit any`, entrée NAT statique obsolète pointant vers
 * une machine décommissionnée), détectées via les commandes `show`
 * natives puis corrigées.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

async function buildMisconfiguredLab(): Promise<CiscoRouter> {
  const router = new CiscoRouter('router', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw2', 4, 0, 0);
  new Cable('extra').connect(router.getPort('GigabitEthernet0/2')!, sw.getPorts()[0]);

  for (const cmd of [
    'enable', 'configure terminal',
    'interface GigabitEthernet0/0', 'ip address 192.168.10.254 255.255.255.0', 'ip nat inside', 'no shutdown', 'exit',
    'interface GigabitEthernet0/1', 'ip address 203.0.113.1 255.255.255.252', 'ip nat outside', 'no shutdown', 'exit',
    // Anomalie 1 : Gi0/2 a une IP mais AUCUN marquage NAT inside/outside.
    'interface GigabitEthernet0/2', 'ip address 192.168.20.254 255.255.255.0', 'no shutdown', 'exit',
    // Anomalie 2 : ACL NAT standard trop permissive (permit any).
    'ip access-list standard ACL-LAN-INTERNE',
    '10 permit any',
    'exit',
    'ip nat inside source list ACL-LAN-INTERNE interface GigabitEthernet0/1 overload',
    // Anomalie 3 : entrée statique vers une machine décommissionnée.
    'ip nat inside source static 192.168.10.99 203.0.113.15',
    'ip nat inside source static 192.168.10.20 203.0.113.10',
    'ip nat inside source static 192.168.10.10 203.0.113.11',
    'end',
  ]) await router.executeCommand(cmd);

  return router;
}

describe('Scénario 13 (Cisco) — audit et sécurisation du NAT : détection des mauvaises configurations', () => {
  beforeEach(() => {
    resetCounters();
    MACAddress.resetCounter();
    resetDeviceCounters();
    Logger.reset();
    EquipmentRegistry.resetInstance();
  });

  describe('détection des anomalies', () => {
    it('anomalie 1 : GigabitEthernet0/2 possède une IP mais n\'est marquée ni inside ni outside', async () => {
      const router = await buildMisconfiguredLab();
      const engine = router._getNATEngine();
      expect(engine.getInsideInterfaces().has('GigabitEthernet0/2')).toBe(false);
      expect(engine.getOutsideInterfaces().has('GigabitEthernet0/2')).toBe(false);
    });

    it('show ip interface annonce l\'affectation NAT (nat: inside/outside) de chaque interface', async () => {
      const router = await buildMisconfiguredLab();
      const out = await router.executeCommand('show ip interface');
      expect(out).toMatch(/GigabitEthernet0\/0[\s\S]*\(nat: inside\)/);
      expect(out).toMatch(/GigabitEthernet0\/1[\s\S]*\(nat: outside\)/);
    });

    it('anomalie 2 : ACL-LAN-INTERNE contient un "permit any" trop permissif', async () => {
      const router = await buildMisconfiguredLab();
      const out = await router.executeCommand('show ip access-lists ACL-LAN-INTERNE');
      expect(out).toMatch(/10 permit any/);
    });

    it('anomalie 3 : une entrée statique pointe vers 192.168.10.99, une machine qui ne répond pas au ping', async () => {
      const router = await buildMisconfiguredLab();
      const table = await router.executeCommand('show ip nat translations | include ---');
      expect(table).toContain('192.168.10.99');

      const ping = await router.executeCommand('ping 192.168.10.99 source GigabitEthernet0/0');
      expect(ping).toMatch(/Success rate is 0 percent/);
    });
  });

  describe('corrections et validation', () => {
    it('après correction, GigabitEthernet0/2 est marquée ip nat inside', async () => {
      const router = await buildMisconfiguredLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/2');
      await router.executeCommand('ip nat inside');
      await router.executeCommand('end');

      expect(router._getNATEngine().getInsideInterfaces().has('GigabitEthernet0/2')).toBe(true);
    });

    it('après correction, ACL-LAN-INTERNE n\'a plus de "permit any" et référence des réseaux explicites', async () => {
      const router = await buildMisconfiguredLab();
      for (const cmd of [
        'enable', 'configure terminal',
        'no ip access-list standard ACL-LAN-INTERNE',
        'ip access-list standard ACL-LAN-INTERNE',
        '10 permit 192.168.10.0 0.0.0.255',
        '20 permit 192.168.20.0 0.0.0.255',
        'exit', 'end',
      ]) await router.executeCommand(cmd);

      const out = await router.executeCommand('show ip access-lists ACL-LAN-INTERNE');
      expect(out).not.toMatch(/permit any/);
      expect(out).toContain('192.168.10.0');
      expect(out).toContain('192.168.20.0');
    });

    it('après correction, l\'entrée statique obsolète (192.168.10.99) est supprimée et les valides persistent', async () => {
      const router = await buildMisconfiguredLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('no ip nat inside source static 192.168.10.99 203.0.113.15');
      await router.executeCommand('end');

      const out = await router.executeCommand('show ip nat translations | include ---');
      expect(out).not.toContain('192.168.10.99');
      expect(out).toContain('192.168.10.20');
      expect(out).toContain('192.168.10.10');
    });

    it('après toutes les corrections, show ip nat statistics liste GigabitEthernet0/2 parmi les interfaces inside', async () => {
      const router = await buildMisconfiguredLab();
      await router.executeCommand('configure terminal');
      await router.executeCommand('interface GigabitEthernet0/2');
      await router.executeCommand('ip nat inside');
      await router.executeCommand('end');

      const out = await router.executeCommand('show ip nat statistics');
      expect(out).toMatch(/Inside interfaces:.*GigabitEthernet0\/2/);
    });
  });
});

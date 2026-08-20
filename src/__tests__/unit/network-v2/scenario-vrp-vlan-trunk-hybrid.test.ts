/**
 * Scénario 2 — Configuration VLAN et trunk sur switch Huawei S-series
 * (purement Huawei).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

describe('Scénario 2 — Configuration VLAN et trunk sur switch Huawei S-series', () => {
  describe('création des VLANs', () => {
    it('vlan <id> + description crée un VLAN visible par display vlan / display vlan <id>', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('description VLAN_ADMIN');
      await sw.executeCommand('quit');
      await sw.executeCommand('vlan 20');
      await sw.executeCommand('description VLAN_PRODUCTION');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const all = await sw.executeCommand('display vlan');
      expect(all).toMatch(/\b10\b/);
      expect(all).toMatch(/\b20\b/);

      const detail10 = await sw.executeCommand('display vlan 10');
      expect(detail10).toMatch(/\b10\b/);
    });

    it('vlan batch crée plusieurs VLANs en une commande', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      const out = await sw.executeCommand('vlan batch 30 40 50');
      expect(out).toMatch(/This operation may take a few seconds/);
      await sw.executeCommand('return');

      const display = await sw.executeCommand('display vlan');
      expect(display).toMatch(/\b30\b/);
      expect(display).toMatch(/\b40\b/);
      expect(display).toMatch(/\b50\b/);
    });
  });

  describe('configuration des ports access', () => {
    it('port link-type access + port default vlan assignent le port à son VLAN', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('description PC-Linux-1');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const iface = await sw.executeCommand('display interface GigabitEthernet 0/0/1');
      expect(iface).not.toMatch(/Invalid input|Incomplete command/);
      expect(iface).toContain('PC-Linux-1');

      const portVlan = await sw.executeCommand('display port vlan GigabitEthernet 0/0/1');
      expect(portVlan).toMatch(/access/);
      expect(portVlan).toMatch(/\b10\b/);

      // Le VLAN 10 doit lister GigabitEthernet0/0/1 parmi ses interfaces membres.
      const vlanDetail = await sw.executeCommand('display vlan 10');
      expect(vlanDetail).toContain('GigabitEthernet0/0/1');
    });
  });

  describe('configuration des ports trunk', () => {
    it('port link-type trunk + allow-pass + pvid sont cohérents entre display port vlan et display current-configuration', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan batch 10 20 30');
      await sw.executeCommand('interface GigabitEthernet 0/0/24');
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('port trunk allow-pass vlan 10 20 30');
      await sw.executeCommand('port trunk pvid vlan 1');
      await sw.executeCommand('description TRUNK-TO-ROUTER');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const portVlan = await sw.executeCommand('display port vlan GigabitEthernet 0/0/24');
      expect(portVlan).toMatch(/trunk/);
      expect(portVlan).toMatch(/GigabitEthernet0\/0\/24/);
      // PVID = 1, Trunk VLAN List = 1 10 20 30 (sémantique additive VRP).
      expect(portVlan).toMatch(/1\s+1 10 20 30|1[\s\S]*1 10 20 30/);

      const config = await sw.executeCommand('display current-configuration');
      expect(config).toMatch(/interface GigabitEthernet0\/0\/24/);
      expect(config).toMatch(/port link-type trunk/);
      expect(config).toMatch(/port trunk allow-pass vlan 1 10 20 30/);

      // Les VLANs 10/20/30 doivent lister ce port trunk parmi leurs membres,
      // pas seulement les ports access.
      for (const id of [10, 20, 30]) {
        const detail = await sw.executeCommand(`display vlan ${id}`);
        expect(detail).toContain('GigabitEthernet0/0/24');
      }
    });
  });

  describe('différences Huawei vs Cisco — port hybrid', () => {
    it('port hybrid avec untagged (PVID) et tagged distincts, sans équivalent Cisco direct', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan batch 10 20 30');
      await sw.executeCommand('interface GigabitEthernet 0/0/5');
      await sw.executeCommand('port link-type hybrid');
      await sw.executeCommand('port hybrid pvid vlan 10');
      await sw.executeCommand('port hybrid untagged vlan 10');
      await sw.executeCommand('port hybrid tagged vlan 20 30');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const portVlan = await sw.executeCommand('display port vlan GigabitEthernet 0/0/5');
      expect(portVlan).toMatch(/hybrid/);
      // VLAN 1 stays untagged by default (same additive-from-VLAN-1
      // semantics as trunk allow-pass); `untagged vlan 10` adds to it.
      expect(portVlan).toMatch(/U:\s*1 10/);
      expect(portVlan).toMatch(/T:\s*20 30/);

      // VLAN 10 (untagged) ET les VLANs 20/30 (tagged) doivent tous lister
      // ce port hybrid parmi leurs membres — comportement impossible à
      // exprimer avec un simple port trunk/access Cisco.
      for (const id of [10, 20, 30]) {
        const detail = await sw.executeCommand(`display vlan ${id}`);
        expect(detail).toContain('GigabitEthernet0/0/5');
      }
    });
  });

  describe('critère de réussite', () => {
    it('display vlan liste description + membres ; display port vlan et current-configuration sont cohérents', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('description VLAN_ADMIN');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet 0/0/24');
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('port trunk allow-pass vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const vlanDetail = await sw.executeCommand('display vlan 10');
      expect(vlanDetail).toContain('GigabitEthernet0/0/1');
      expect(vlanDetail).toContain('GigabitEthernet0/0/24');

      const portVlan = await sw.executeCommand('display port vlan');
      expect(portVlan).toMatch(/access/);
      expect(portVlan).toMatch(/trunk/);

      const config = await sw.executeCommand('display current-configuration');
      expect(config).toMatch(/port link-type trunk/);
      expect(config).toMatch(/port trunk allow-pass vlan 1 10/);
    });
  });
});

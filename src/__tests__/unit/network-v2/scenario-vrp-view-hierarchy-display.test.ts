/**
 * Scénario 1 — Prise en main VRP : navigation dans les vues et commandes
 * display fondamentales.
 *
 * Adaptations à la réalité de la plateforme :
 *  - la vue `ospf 1` n'existe que sur le routeur AR-series (un switch L2
 *    Huawei S-series basique n'a pas de vue OSPF) ; la vue `vlan N`
 *    n'existe que sur le switch. Le tutoriel du scénario les présente sous
 *    un même prompt générique `<Huawei>` ; ce test les exerce chacune sur
 *    l'équipement qui les supporte réellement.
 *  - `save` (chemin non interactif `executeCommand`) confirme sans le
 *    dialogue `Warning:`/`[Y/N]` — celui-ci existe mais appartient au plan
 *    d'interaction du terminal réel (`HuaweiInteractionPlans.ts`), qui
 *    suppose la réponse "yes" pour le chemin `executeCommand`. Le message
 *    de confirmation final « Save the configuration successfully. » est
 *    en revanche identique dans les deux chemins et c'est celui-ci que le
 *    critère de réussite retient.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
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

describe('Scénario 1 — Prise en main VRP : vues et display fondamentaux', () => {
  describe('hiérarchie des vues VRP sur le switch S-series', () => {
    it('le prompt suit user view (<>) → system view ([]) → interface view → vlan view → retours', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'Huawei');
      expect((await sw.executeCommand('')).trim()).toBe('');

      // user view
      expect(sw.getPrompt()).toBe('<Huawei>');

      await sw.executeCommand('system-view');
      expect(sw.getPrompt()).toBe('[Huawei]');

      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      expect(sw.getPrompt()).toBe('[Huawei-GigabitEthernet0/0/1]');

      // quit une vue → vue précédente (system view)
      await sw.executeCommand('quit');
      expect(sw.getPrompt()).toBe('[Huawei]');

      await sw.executeCommand('vlan 10');
      expect(sw.getPrompt()).toBe('[Huawei-vlan10]');
      await sw.executeCommand('quit');
      expect(sw.getPrompt()).toBe('[Huawei]');

      // return depuis une sous-vue → directement en user view
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      expect(sw.getPrompt()).toBe('[Huawei-GigabitEthernet0/0/1]');
      await sw.executeCommand('return');
      expect(sw.getPrompt()).toBe('<Huawei>');
    });
  });

  describe('hiérarchie des vues VRP sur le routeur AR-series (vue OSPF)', () => {
    it('system-view → interface view → ospf view → quit/return', async () => {
      const r = new HuaweiRouter('Huawei');
      expect(r.getPrompt()).toBe('<Huawei>');

      await r.executeCommand('system-view');
      expect(r.getPrompt()).toBe('[Huawei]');

      // The AR-series router's own convention abbreviates its physical
      // interfaces to GE0/0/0 in the prompt (confirmed against existing
      // router shell tests), unlike the S-series switch which keeps the
      // full GigabitEthernet0/0/0 form.
      await r.executeCommand('interface GigabitEthernet 0/0/0');
      expect(r.getPrompt()).toBe('[Huawei-GE0/0/0]');
      await r.executeCommand('quit');
      expect(r.getPrompt()).toBe('[Huawei]');

      await r.executeCommand('ospf 1');
      expect(r.getPrompt()).toBe('[Huawei-ospf-1]');
      await r.executeCommand('return');
      expect(r.getPrompt()).toBe('<Huawei>');
    });
  });

  describe('commandes display fondamentales — équivalents Cisco', () => {
    it('display version affiche la plateforme VRP', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const r = new HuaweiRouter('AR1');
      for (const dev of [sw, r]) {
        const out = await dev.executeCommand('display version');
        expect(out).toContain('VRP');
        expect(out.toLowerCase()).toMatch(/versatile routing platform/);
      }
    });

    it('display current-configuration reflète la configuration appliquée, structurée par sections', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('sysname SW1');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const out = await sw.executeCommand('display current-configuration');
      expect(out).toContain('sysname SW1');
      expect(out).toMatch(/vlan 10/);
      expect(out).toMatch(/interface GigabitEthernet0\/0\/1/);
      expect(out).toMatch(/port link-type access/);
      expect(out).toMatch(/port default vlan 10/);
    });

    it('display saved-configuration reflète le dernier save, distinct de la configuration active', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const beforeSave = await sw.executeCommand('display saved-configuration');
      expect(beforeSave).toMatch(/doesn't exist/);

      await sw.executeCommand('system-view');
      await sw.executeCommand('sysname SW1');
      await sw.executeCommand('return');
      await sw.executeCommand('save');

      const saved = await sw.executeCommand('display saved-configuration');
      expect(saved).toContain('sysname SW1');

      // Une modification postérieure au save n'apparaît pas dans le
      // snapshot sauvegardé tant qu'un nouveau `save` n'est pas exécuté.
      await sw.executeCommand('system-view');
      await sw.executeCommand('sysname SW1-RENAMED');
      await sw.executeCommand('return');
      const savedAfterUnsavedChange = await sw.executeCommand('display saved-configuration');
      expect(savedAfterUnsavedChange).toContain('sysname SW1');
      expect(savedAfterUnsavedChange).not.toContain('SW1-RENAMED');
    });

    it('display interface reflète l\'état physique réel de l\'interface', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      await sw.executeCommand('description LINK-TO-PC');
      await sw.executeCommand('return');

      const out = await sw.executeCommand('display interface GigabitEthernet 0/0/1');
      expect(out).not.toMatch(/Invalid input|Incomplete command/);
      expect(out).toContain('GigabitEthernet0/0/1');
      expect(out).toContain('LINK-TO-PC');
    });

    it('display ip interface brief liste les interfaces avec leur IP et leur état, sur le switch ET le routeur', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif 10');
      await sw.executeCommand('ip address 192.168.10.1 255.255.255.0');
      await sw.executeCommand('return');
      const swOut = await sw.executeCommand('display ip interface brief');
      expect(swOut).not.toMatch(/Invalid input|Incomplete command|Unrecognized/);
      expect(swOut).toContain('192.168.10.1');

      const r = new HuaweiRouter('AR1');
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet 0/0/0');
      await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('return');
      const rOut = await r.executeCommand('display ip interface brief');
      expect(rOut).not.toMatch(/Invalid input|Incomplete command|Unrecognized/);
      expect(rOut).toContain('192.168.1.1');
    });

    it('display vlan liste les VLANs configurés', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('vlan 20');
      await sw.executeCommand('quit');
      await sw.executeCommand('return');

      const out = await sw.executeCommand('display vlan');
      expect(out).toMatch(/\b10\b/);
      expect(out).toMatch(/\b20\b/);
    });

    it('display mac-address affiche la table MAC du switch', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const out = await sw.executeCommand('display mac-address');
      expect(out).not.toMatch(/Invalid input|Incomplete command|Unrecognized/);
    });

    it('display arp affiche la table ARP', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      const r = new HuaweiRouter('AR1');
      for (const dev of [sw, r]) {
        const out = await dev.executeCommand('display arp');
        expect(out).not.toMatch(/Invalid input|Incomplete command|Unrecognized/);
      }
    });

    it('display ip routing-table affiche la table de routage', async () => {
      const r = new HuaweiRouter('AR1');
      // Une route Direct n'existe que tant que le lien est up : une
      // interface sans câble est down/down et ne peuple pas la RIB.
      const pc = new LinuxPC('linux-pc', 'PC-DIRECT', 0, 0);
      new Cable('lien').connect(r.getPort('GE0/0/0')!, pc.getPort('eth0')!);
      await r.executeCommand('system-view');
      await r.executeCommand('interface GigabitEthernet 0/0/0');
      await r.executeCommand('ip address 192.168.1.1 255.255.255.0');
      await r.executeCommand('undo shutdown');
      await r.executeCommand('return');

      const out = await r.executeCommand('display ip routing-table');
      expect(out).toContain('Destination/Mask');
      expect(out).toMatch(/192\.168\.1\.0\/24/);
      expect(out).toMatch(/Direct/);
    });
  });

  describe('tableau comparatif VRP vs IOS', () => {
    it('le tableau comparatif est un heredoc shell exécutable côté Linux, listant les équivalences clés', async () => {
      const pc = new LinuxPC('linux-pc', 'PC', 0, 0);
      const out = await pc.executeCommand(
        `echo "=== TABLEAU COMPARATIF HUAWEI VRP vs CISCO IOS ==="
cat << 'EOF2'
configure terminal | system-view
show running-config | display current-configuration
copy run start | save
show ip route | display ip routing-table
EOF2`,
      );
      expect(out).toContain('=== TABLEAU COMPARATIF HUAWEI VRP vs CISCO IOS ===');
      expect(out).toContain('configure terminal | system-view');
      expect(out).toContain('show running-config | display current-configuration');
      expect(out).toContain('copy run start | save');
      expect(out).toContain('show ip route | display ip routing-table');
    });
  });

  describe('sauvegarde de la configuration VRP', () => {
    it('save confirme la sauvegarde avec le message VRP attendu, depuis n\'importe quelle vue', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      await sw.executeCommand('system-view');
      await sw.executeCommand('sysname SW1');
      await sw.executeCommand('return');

      const out = await sw.executeCommand('save');
      expect(out).toMatch(/current configuration will be written to the device/i);
      expect(out).toMatch(/Now saving the current configuration to the slot/);
      expect(out).toContain('Save the configuration successfully.');
    });
  });

  describe('critère de réussite', () => {
    it('prompts corrects par vue, display current-configuration structuré, save confirmé', async () => {
      const sw = new HuaweiSwitch('switch-huawei', 'SW1');
      expect(sw.getPrompt()).toMatch(/^<.*>$/);
      await sw.executeCommand('system-view');
      expect(sw.getPrompt()).toMatch(/^\[[^-]+\]$/);
      await sw.executeCommand('interface GigabitEthernet 0/0/1');
      expect(sw.getPrompt()).toMatch(/^\[.+-GigabitEthernet0\/0\/1\]$/);
      await sw.executeCommand('port link-type trunk');
      await sw.executeCommand('port trunk allow-pass vlan 10 20');
      await sw.executeCommand('return');

      const config = await sw.executeCommand('display current-configuration');
      expect(config).toMatch(/interface GigabitEthernet0\/0\/1/);
      expect(config).toMatch(/port link-type trunk/);
      // VRP's default trunk allow-list is VLAN 1; `allow-pass vlan 10 20`
      // is additive, so the real result is 1 10 20, not a replacement.
      expect(config).toMatch(/port trunk allow-pass vlan 1 10 20/);

      const saveOut = await sw.executeCommand('save');
      expect(saveOut).toContain('Save the configuration successfully.');
    });
  });
});

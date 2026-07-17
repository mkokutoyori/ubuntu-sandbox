/**
 * Sanity tests for the CLI foundation as plugged into switches. Miroir
 * strict de `router-cli-foundation.test.ts` — même pipeline, mêmes
 * mécaniques (single gate through interpreter, mode transitions,
 * abbreviations), appliqué à un équipement L2. Preuve exécutable que
 * les switches passent bien par le nouveau socle et non plus par
 * `ISwitchShell.execute()`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  EquipmentRegistry.resetInstance();
});

describe('Switch CLI foundation — command-kernel single-gate pipeline', () => {
  describe('Cisco Catalyst switch', () => {
    it('the default prompt is `<hostname>>` (user mode)', () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      expect(sw.getPrompt()).toBe('SW1>');
    });

    it('`enable` transitions to privileged mode', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      await sw.executeCommand('enable');
      expect(sw.getPrompt()).toBe('SW1#');
    });

    it('`configure terminal` pushes into config mode', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      expect(sw.getPrompt()).toBe('SW1(config)#');
    });

    it('`end` from config mode returns to privileged', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      await sw.executeCommand('enable');
      await sw.executeCommand('configure terminal');
      await sw.executeCommand('end');
      expect(sw.getPrompt()).toBe('SW1#');
    });

    it('abbreviations : `en` → `enable`, `conf t` → `configure terminal`, `sh ver` → `show version`', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      await sw.executeCommand('en');
      expect(sw.getPrompt()).toBe('SW1#');
      await sw.executeCommand('conf t');
      expect(sw.getPrompt()).toBe('SW1(config)#');
      await sw.executeCommand('end');
      const out = await sw.executeCommand('sh ver');
      expect(out).toMatch(/Cisco IOS Software/);
    });

    it('`show version` produces the C2960 switch banner (distinct from router)', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('show version');
      // Le banner switch cite le modèle Catalyst 2960 explicitement —
      // le banner routeur cite ISR2911. Séparation nette entre les deux.
      expect(out).toMatch(/C2960/);
      expect(out).toMatch(/^SW1 uptime is /m);
      expect(out).toMatch(/WS-C2960-24TT-L/);
      expect(out).not.toMatch(/C2900|ISR2911/);
    });

    it('`show vlan brief` produces the IOS tabular banner using only MachineApi', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('show vlan brief');
      // En-tête et séparateur IOS (largeurs de colonnes reproduites
      // inline par la commande — aucun formateur legacy).
      expect(out).toMatch(/^VLAN Name {29}Status {4}Ports$/m);
      expect(out).toMatch(/^---- -{32} -{9} -{31}$/m);
      // VLAN 1 par défaut (`default`) actif, présent sur un switch
      // Catalyst 24 ports.
      expect(out).toMatch(/^1 {4}default {26}active {4}/m);
      // Les ports d'accès sont abrégés à la Cisco (Fa0/1, …) — la
      // commande fait elle-même l'abréviation, sans helper legacy.
      expect(out).toMatch(/Fa0\/1/);
    });

    it('abbreviation `sh vl br` résout jusqu\'à la feuille (préfixe-unique)', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('sh vl br');
      expect(out).toMatch(/^VLAN Name /m);
      expect(out).toMatch(/^1 {4}default/m);
    });

    it('`show vlan` seul est incomplete (vue full non migrée, signal explicite)', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('show vlan');
      expect(out).toMatch(/Incomplete/);
    });

    it('`show mac address-table` produit l\'en-tête IOS 2960 depuis MachineApi', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('show mac address-table');
      expect(out).toMatch(/^Mac Address Table$/m);
      expect(out).toMatch(/^-{43}$/m);
      // Aucune entrée dynamique par défaut → « No entries. » (format vendeur).
      expect(out).toMatch(/^No entries\.$/m);
    });

    it('abbreviation `sh mac add` résout jusqu\'à `show mac address-table`', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('sh mac add');
      expect(out).toMatch(/^Mac Address Table$/m);
    });

    it('`show mac` seul est incomplete (composite non exécutable)', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      const out = await sw.executeCommand('show mac');
      expect(out).toMatch(/Incomplete/);
    });

    it('an unmigrated command fails through the new pipeline (signal for migration)', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      await sw.executeCommand('enable');
      // `show port-security` : vue port-security non migrée → « Incomplete » /
      // « Invalid input » via le nouveau pipeline.
      const out = await sw.executeCommand('show port-security');
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable|Invalid input|Unrecognized command/i);
    });
  });

  describe('Huawei S5720 switch', () => {
    it('the default prompt is `<hostname>` (user-view mode)', () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      expect(sw.getPrompt()).toBe('<SW2>');
    });

    it('`system-view` transitions to system-view and prints the entry line', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      const out = await sw.executeCommand('system-view');
      expect(out).toContain('Enter system view');
      expect(sw.getPrompt()).toBe('[SW2]');
    });

    it('`quit` from system-view returns to user-view', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('quit');
      expect(sw.getPrompt()).toBe('<SW2>');
    });

    it('`display version` produces the S5720 banner (distinct from AR2220 router)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      const out = await sw.executeCommand('display version');
      expect(out).toMatch(/Huawei Versatile Routing Platform/);
      expect(out).toMatch(/^SW2 uptime is /m);
      expect(out).toMatch(/S5720/);
      expect(out).not.toMatch(/AR2220/);
    });

    // ─── Vague display L2 ────────────────────────────────────────────

    it('`display vlan` liste au moins le VLAN 1 par défaut à partir de MachineApi', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      const out = await sw.executeCommand('display vlan');
      expect(out).toMatch(/^VLAN ID +Name +Status +Ports$/m);
      // VLAN 1 est initialisé avec le nom `default` côté Switch.
      expect(out).toMatch(/^1 +default +active/m);
    });

    it('`display mac-address` produit la bannière S5720 (aucune entrée par défaut)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      const out = await sw.executeCommand('display mac-address');
      expect(out).toMatch(/^MAC address table of slot 0:$/m);
      expect(out).toMatch(/^MAC Address +VLAN\/VSI +Learned-From +Type$/m);
      expect(out).toMatch(/^Total items displayed = 0$/m);
    });

    it('abbreviation `dis mac` résout jusqu\'à `display mac-address` (préfixe-unique)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      const out = await sw.executeCommand('dis mac');
      expect(out).toMatch(/^MAC address table of slot 0:$/m);
    });

    // ─── Vague sysname + interface-view ──────────────────────────────

    it('`sysname SW99` met à jour le prompt via MachineApi', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('sysname SW99');
      expect(sw.getPrompt()).toBe('[SW99]');
    });

    it('`interface GigabitEthernet0/0/1` push interface-view avec l\'interface dans le prompt', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      const out = await sw.executeCommand('interface GigabitEthernet0/0/1');
      expect(out).toBe('');
      expect(sw.getPrompt()).toBe('[SW2-GigabitEthernet0/0/1]');
    });

    it('`interface DoesNotExist` refuse la transition avec le message VRP', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      const out = await sw.executeCommand('interface DoesNotExist');
      expect(out).toMatch(/Wrong parameter/);
      expect(sw.getPrompt()).toBe('[SW2]');
    });

    it('`shutdown` (interface-view) marque le port admin-down via MachineApi', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('shutdown');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { interface(n: string): { adminUp: boolean } | null } } } }).getCommandKernelCli();
      const info = cli.machine.switch.interface('GigabitEthernet0/0/1');
      expect(info?.adminUp).toBe(false);
    });

    it('`undo shutdown` remonte le port', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('shutdown');
      await sw.executeCommand('undo shutdown');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { interface(n: string): { adminUp: boolean } | null } } } }).getCommandKernelCli();
      expect(cli.machine.switch.interface('GigabitEthernet0/0/1')?.adminUp).toBe(true);
    });

    it('`description WAN uplink` pose la description via MachineApi', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('description WAN uplink');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { interface(n: string): { description: string } | null } } } }).getCommandKernelCli();
      expect(cli.machine.switch.interface('GigabitEthernet0/0/1')?.description).toBe('WAN uplink');
    });

    it('`quit` d\'interface-view efface `selectedInterface` (clearOnExit)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      expect(sw.getPrompt()).toBe('[SW2-GigabitEthernet0/0/1]');
      await sw.executeCommand('quit');
      expect(sw.getPrompt()).toBe('[SW2]');
    });

    // ─── Vague VLAN + port link-type + port default vlan ─────────────

    it('`vlan 10` (system-view) crée le VLAN et push vlan-view avec l\'id dans le prompt', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      expect(sw.getPrompt()).toBe('[SW2-vlan10]');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { vlan(id: number): { id: number } | null } } } }).getCommandKernelCli();
      expect(cli.machine.switch.vlan(10)).not.toBeNull();
    });

    it('`description Servers` en vlan-view renomme le VLAN sélectionné', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('description Servers');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { vlan(id: number): { name: string } | null } } } }).getCommandKernelCli();
      expect(cli.machine.switch.vlan(10)?.name).toBe('Servers');
    });

    it('`quit` de vlan-view efface `selectedVlan` (clearOnExit)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      expect(sw.getPrompt()).toBe('[SW2-vlan10]');
      await sw.executeCommand('quit');
      expect(sw.getPrompt()).toBe('[SW2]');
    });

    it('`undo vlan 10` supprime le VLAN via MachineApi', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('undo vlan 10');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { vlan(id: number): unknown | null } } } }).getCommandKernelCli();
      expect(cli.machine.switch.vlan(10)).toBeNull();
    });

    it('`undo vlan 1` refuse (VLAN par défaut) avec le message vendeur', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      const out = await sw.executeCommand('undo vlan 1');
      expect(out).toMatch(/default VLAN cannot be deleted/i);
    });

    it('`port link-type access` puis `port default vlan 10` assigne l\'access-VLAN visible dans display vlan', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('end');
      const out = await sw.executeCommand('display vlan');
      // La ligne VLAN 10 doit lister GE0/0/1 dans ses ports.
      expect(out).toMatch(/^10 +VLAN0010 +active +GigabitEthernet0\/0\/1$/m);
    });

    it('`port default vlan 10` avant `port link-type access` échoue avec le message VRP', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('port link-type trunk');
      const out = await sw.executeCommand('port default vlan 10');
      expect(out).toMatch(/first set the port link-type as access/i);
    });

    it('`undo port default vlan` remet le port en VLAN 1', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('quit');
      await sw.executeCommand('interface GigabitEthernet0/0/1');
      await sw.executeCommand('port link-type access');
      await sw.executeCommand('port default vlan 10');
      await sw.executeCommand('undo port default vlan');
      const cli = (sw as unknown as { getCommandKernelCli(): { machine: { switch: { interface(n: string): { accessVlan: number } | null } } } }).getCommandKernelCli();
      expect(cli.machine.switch.interface('GigabitEthernet0/0/1')?.accessVlan).toBe(1);
    });

    it('`stp enable` (system-view) est acceptée silencieusement (no-op vendor)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      const out = await sw.executeCommand('stp enable');
      expect(out).toBe('');
    });

    it('`display stp brief` produit les colonnes VRP à partir des interfaces MachineApi', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      const out = await sw.executeCommand('display stp brief');
      expect(out).toMatch(/^MSTID +Port +Role +STP State +Protection$/m);
      expect(out).toMatch(/^0 +GigabitEthernet0\/0\/1 /m);
    });

    it('`interface Vlanif10` push interface-view avec le nom SVI dans le prompt', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif10');
      expect(sw.getPrompt()).toBe('[SW2-Vlanif10]');
    });

    it('`interface Vlanif 20` (2 tokens) push interface-view (identique 1 token)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      await sw.executeCommand('interface Vlanif 20');
      expect(sw.getPrompt()).toBe('[SW2-Vlanif20]');
    });

    it('`mac-address aging-time 300` (system-view) est acceptée silencieusement', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      const out = await sw.executeCommand('mac-address aging-time 300');
      expect(out).toBe('');
    });

    it('an unmigrated command fails through the new pipeline (signal for migration)', async () => {
      const sw = new HuaweiSwitch('sw-huawei', 'SW2', 24);
      await sw.executeCommand('system-view');
      // `ntp-service unicast-server 1.1.1.1` n'est pas migré → not-found
      // via le nouveau pipeline (stp enable est désormais migré).
      const out = await sw.executeCommand('ntp-service unicast-server 1.1.1.1');
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable|Invalid input|Unrecognized command/i);
    });
  });

  describe('GenericSwitch (Cisco-flavored grammar)', () => {
    it('reuses the Cisco switch bootstrap (default prompt `<hostname>>`)', () => {
      const sw = new GenericSwitch('switch-generic', 'GSW', 8);
      expect(sw.getPrompt()).toBe('GSW>');
    });

    it('`show version` works on GenericSwitch (Cisco-flavored)', async () => {
      const sw = new GenericSwitch('switch-generic', 'GSW', 8);
      const out = await sw.executeCommand('show version');
      expect(out).toMatch(/Cisco IOS Software/);
      expect(out).toMatch(/^GSW uptime is /m);
    });
  });
});

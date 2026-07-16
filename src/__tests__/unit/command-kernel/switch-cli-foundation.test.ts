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
      const out = await sw.executeCommand('show interfaces status');
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable/i);
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

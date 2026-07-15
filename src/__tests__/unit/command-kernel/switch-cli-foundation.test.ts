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

    it('an unmigrated command fails through the new pipeline (signal for migration)', async () => {
      const sw = new CiscoSwitch('sw-cisco', 'SW1', 24);
      await sw.executeCommand('enable');
      const out = await sw.executeCommand('show vlan');
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

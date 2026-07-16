/**
 * Sanity tests for the new CLI foundation (`command-kernel/cli/`) as
 * plugged into the router equipment stack. Exercises the single-gate
 * pipeline end-to-end : `Router.executeCommand` → `CliInterpreter` →
 * hierarchical resolution → command execution → typed output.
 *
 * These tests are the executable proof that the legacy `IRouterShell`
 * is no longer consulted for command execution. Any command not yet
 * migrated to the new registry MUST fail through this path (that's
 * the migration signal).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

beforeEach(() => {
  resetCounters();
  EquipmentRegistry.resetInstance();
});

describe('Router CLI foundation — command-kernel single-gate pipeline', () => {
  describe('Cisco IOS', () => {
    it('the default prompt is `<hostname>>` (user mode)', () => {
      const r = new CiscoRouter('R1');
      expect(r.getPrompt()).toBe('R1>');
    });

    it('`enable` transitions from user to privileged mode and updates the prompt', async () => {
      const r = new CiscoRouter('R1');
      expect(r.getPrompt()).toBe('R1>');
      await r.executeCommand('enable');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('`disable` transitions back from privileged to user', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('disable');
      expect(r.getPrompt()).toBe('R1>');
    });

    it('`configure terminal` pushes into config mode', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      expect(r.getPrompt()).toBe('R1(config)#');
    });

    it('`exit` from config mode returns to privileged', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('exit');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('`end` from config mode returns straight to privileged', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      await r.executeCommand('configure terminal');
      await r.executeCommand('end');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('abbreviations resolve preferring unique prefixes (`en` → `enable`, `sh` → `show`, `conf t` → `configure terminal`)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('en');
      expect(r.getPrompt()).toBe('R1#');
      await r.executeCommand('conf t');
      expect(r.getPrompt()).toBe('R1(config)#');
      await r.executeCommand('end');
      const out = await r.executeCommand('sh version');
      expect(out).toMatch(/Cisco IOS Software/);
    });

    it('`show version` produces the full IOS banner using only MachineApi as data source', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show version');
      expect(out).toMatch(/Cisco IOS Software/);
      expect(out).toMatch(/^R1 uptime is /m);
      expect(out).toMatch(/Version 15\.7\(3\)M5/);
    });

    it('`show` alone is incomplete (no legacy fallback)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show');
      expect(out).toMatch(/Incomplete/);
    });

    it('`show ip interface brief` produces the IOS tabular banner using only MachineApi', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip interface brief');
      // En-tête IOS exact (largeurs de colonnes reproduites inline par
      // la commande — aucun formateur legacy).
      expect(out).toMatch(/^Interface {18}IP-Address {6}OK\? Method Status {16}Protocol$/m);
      // Chaque interface de démarrage (GigabitEthernet0/0..3) est listée
      // avec `unassigned` (aucune IP par défaut) et `down`/`down` (câble
      // non connecté).
      expect(out).toMatch(/^GigabitEthernet0\/0 {9}unassigned {6}YES manual down {18}down$/m);
      expect(out).toMatch(/^GigabitEthernet0\/3 /m);
    });

    it('abbreviation `sh ip int br` résout jusqu\'à la feuille (préfixe-unique)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('sh ip int br');
      expect(out).toMatch(/^Interface {18}IP-Address /m);
      expect(out).toMatch(/GigabitEthernet0\/0/);
    });

    it('`show ip` seul est incomplete (composite non exécutable, pas de fallback legacy)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip');
      expect(out).toMatch(/Incomplete/);
    });

    it('`show ip interface` seul est incomplete (composite non exécutable)', async () => {
      const r = new CiscoRouter('R1');
      const out = await r.executeCommand('show ip interface');
      expect(out).toMatch(/Incomplete/);
    });

    it('an unmigrated command fails through the new pipeline (signal for migration)', async () => {
      const r = new CiscoRouter('R1');
      await r.executeCommand('enable');
      // `show ip route` : `route` n'est pas encore une sous-commande de
      // `show ip` → l'interpréteur s'arrête sur `ip` (composite), qui
      // retourne « Incomplete command. ». Signal explicite : migrer
      // `show ip route` viendra plus tard.
      const out = await r.executeCommand('show ip route');
      expect(out).toMatch(/inconnu|Incomplete|not-found|introuvable/i);
    });
  });

  describe('Huawei VRP', () => {
    it('the default prompt is `<hostname>` (user-view mode)', () => {
      const r = new HuaweiRouter('R2');
      expect(r.getPrompt()).toBe('<R2>');
    });

    it('`system-view` transitions from user-view to system-view and updates the prompt', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('system-view');
      expect(out).toContain('Enter system view');
      expect(r.getPrompt()).toBe('[R2]');
    });

    it('`quit` from system-view returns to user-view', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('system-view');
      await r.executeCommand('quit');
      expect(r.getPrompt()).toBe('<R2>');
    });

    it('`display version` produces the VRP banner using only MachineApi', async () => {
      const r = new HuaweiRouter('R2');
      const out = await r.executeCommand('display version');
      expect(out).toMatch(/Huawei Versatile Routing Platform/);
      expect(out).toMatch(/^R2 uptime is /m);
    });

    it('abbreviations resolve on VRP too (`sys` → `system-view`, `dis ver` → `display version`)', async () => {
      const r = new HuaweiRouter('R2');
      await r.executeCommand('sys');
      expect(r.getPrompt()).toBe('[R2]');
      const out = await r.executeCommand('dis ver');
      expect(out).toMatch(/Huawei Versatile Routing Platform/);
    });
  });
});

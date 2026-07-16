/**
 * Palette dédiée : configuration Cisco Catalyst en modes config /
 * config-if / config-vlan sur le socle command-kernel.
 *
 * Ces cas couvrent :
 *  - hostname, interface (push config-if), vlan (push config-vlan)
 *  - switchport mode access/trunk, switchport access vlan
 *  - shutdown / no shutdown, description / no description
 *  - name en config-vlan
 *  - effets sur `show vlan brief` (lecture bout-en-bout)
 *  - transitions / clearOnExit / abréviations / isolation entre modes
 *
 * Toutes les lectures d'état passent :
 *  - soit par la sortie textuelle vendeur (`executeCommand`) ;
 *  - soit par la MachineApi (`getCommandKernelCli().machine`), jamais
 *    par un accès direct à `Switch`/`Port`/`VLANEntry`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { SwitchMachineApi } from '@/network/devices/switch/command-kernel/SwitchMachineApi';

beforeEach(() => {
  resetCounters();
  EquipmentRegistry.resetInstance();
});

function machineOf(sw: CiscoSwitch): SwitchMachineApi {
  return (sw as unknown as { getCommandKernelCli(): { machine: SwitchMachineApi } })
    .getCommandKernelCli().machine;
}

async function toConfig(hostname: string = 'SW1', ports: number = 24): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('sw-cisco', hostname, ports);
  await sw.executeCommand('enable');
  await sw.executeCommand('configure terminal');
  return sw;
}

describe('Cisco Catalyst — configuration L2 (command-kernel)', () => {

  // ─── Bloc 1 : hostname et transitions racines ───────────────────

  describe('Hostname et transitions', () => {
    it('`hostname SW-CORE` met à jour le prompt (config)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('hostname SW-CORE');
      expect(sw.getPrompt()).toBe('SW-CORE(config)#');
    });

    it('`hostname 123bad` refuse (validation Cisco) et laisse hostname inchangé', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('hostname 123bad');
      expect(out).toMatch(/Invalid input/);
      expect(sw.getPrompt()).toBe('SW1(config)#');
    });
  });

  // ─── Bloc 2 : interface push config-if ──────────────────────────

  describe('Push mode config-if', () => {
    it('`interface FastEthernet0/1` bascule en config-if', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      expect(sw.getPrompt()).toBe('SW1(config-if)#');
    });

    it('`interface Fa99/99` (inexistant) refuse et reste en config', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('interface Fa99/99');
      expect(out).toMatch(/Invalid input/);
      expect(sw.getPrompt()).toBe('SW1(config)#');
    });

    it('`exit` de config-if efface `selectedInterface` (clearOnExit)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('exit');
      expect(sw.getPrompt()).toBe('SW1(config)#');
      // Ré-entrer : la nouvelle sélection est bien indépendante.
      await sw.executeCommand('interface FastEthernet0/2');
      await sw.executeCommand('switchport mode access');
      const info = machineOf(sw).switch.interface('FastEthernet0/2');
      expect(info?.mode).toBe('access');
    });
  });

  // ─── Bloc 3 : switchport mode ───────────────────────────────────

  describe('switchport mode access | trunk', () => {
    it('`switchport mode access` positionne mode=access via DTO', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport mode access');
      expect(out).toBe('');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.mode).toBe('access');
    });

    it('`switchport mode trunk` positionne mode=trunk via DTO', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.mode).toBe('trunk');
    });

    it('`switchport mode` seul est incomplete', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport mode');
      expect(out).toMatch(/Incomplete/);
    });

    it('`switchport` seul est incomplete', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport');
      expect(out).toMatch(/Incomplete/);
    });
  });

  // ─── Bloc 4 : switchport access vlan + VLAN implicite ───────────

  describe('switchport access vlan', () => {
    it('`switchport access vlan 10` crée le VLAN à la volée et positionne accessVlan=10', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode access');
      const out = await sw.executeCommand('switchport access vlan 10');
      expect(out).toBe('');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.accessVlan).toBe(10);
      // Le VLAN 10 apparaît dans la base VLAN.
      expect(machineOf(sw).switch.vlan(10)).not.toBeNull();
    });

    it('`switchport access vlan 0` refuse (hors bornes)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport access vlan 0');
      expect(out).toMatch(/Invalid input/);
    });

    it('`switchport access vlan 4095` refuse (hors bornes)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport access vlan 4095');
      expect(out).toMatch(/Invalid input/);
    });
  });

  // ─── Bloc 5 : mode config-vlan ───────────────────────────────────

  describe('vlan <id> (mode config-vlan)', () => {
    it('`vlan 10` crée le VLAN et push config-vlan', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('vlan 10');
      expect(out).toBe('');
      expect(sw.getPrompt()).toBe('SW1(config-vlan)#');
      expect(machineOf(sw).switch.vlan(10)).not.toBeNull();
    });

    it('`vlan 10` puis `name Sales` renomme le VLAN 10', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('name Sales');
      expect(machineOf(sw).switch.vlan(10)?.name).toBe('Sales');
    });

    it('re-entrer `vlan 10` est idempotent (pas de duplication)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('name First');
      await sw.executeCommand('exit');
      await sw.executeCommand('vlan 10');
      // Le nom précédent est conservé — la sélection est un simple push.
      expect(machineOf(sw).switch.vlan(10)?.name).toBe('First');
    });

    it('`vlan 0` refuse (hors bornes)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('vlan 0');
      expect(out).toMatch(/Invalid input/);
      expect(sw.getPrompt()).toBe('SW1(config)#');
    });

    it('`exit` de config-vlan efface `selectedVlan` (clearOnExit)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('exit');
      expect(sw.getPrompt()).toBe('SW1(config)#');
    });
  });

  // ─── Bloc 6 : shutdown / description / no ────────────────────────

  describe('shutdown / description et négations', () => {
    it('`shutdown` puis `no shutdown` bascule adminUp', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('shutdown');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.adminUp).toBe(false);
      await sw.executeCommand('no shutdown');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.adminUp).toBe(true);
    });

    it('`description Uplink to core` puis `no description`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('description Uplink to core');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.description).toBe('Uplink to core');
      await sw.executeCommand('no description');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.description).toBe('');
    });
  });

  // ─── Bloc 7 : effet bout-en-bout sur show vlan brief ────────────

  describe('Effet sur `show vlan brief`', () => {
    it('un port en `access vlan 10` apparaît sous VLAN 10 dans show vlan brief', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode access');
      await sw.executeCommand('switchport access vlan 10');
      await sw.executeCommand('end');
      const out = await sw.executeCommand('show vlan brief');
      // Le VLAN 10 est listé avec Fa0/1 dans ses ports.
      expect(out).toMatch(/^10\s+VLAN0010\s+active\s+Fa0\/1/m);
    });

    it('`vlan 20` + `name Guests` apparaît nommé dans show vlan brief', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 20');
      await sw.executeCommand('name Guests');
      await sw.executeCommand('end');
      const out = await sw.executeCommand('show vlan brief');
      expect(out).toMatch(/^20\s+Guests\s+active/m);
    });
  });

  // ─── Bloc 8 : abréviations préfixe-unique ───────────────────────

  describe('Abréviations', () => {
    it('`int Fa0/1` résout `interface`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('int FastEthernet0/1');
      expect(sw.getPrompt()).toBe('SW1(config-if)#');
    });

    it('`sw mo acc` résout `switchport mode access`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw mo acc');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.mode).toBe('access');
    });

    it('`sw acc vl 10` résout `switchport access vlan 10`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw acc vl 10');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.accessVlan).toBe(10);
    });
  });

  // ─── Bloc 9 : isolation entre modes (règle 9) ───────────────────

  describe('Isolation entre modes', () => {
    it('`switchport` est indisponible en config (registre séparé)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('switchport mode access');
      expect(out).toMatch(/inconnu|introuvable|Incomplete|not-found/i);
    });

    it('`name` est indisponible en config-if (mode config-vlan uniquement)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('name Foo');
      expect(out).toMatch(/inconnu|introuvable|Incomplete|not-found/i);
    });

    it('`interface` est indisponible en config-vlan', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 10');
      const out = await sw.executeCommand('interface FastEthernet0/1');
      expect(out).toMatch(/inconnu|introuvable|Incomplete|not-found/i);
    });
  });
});

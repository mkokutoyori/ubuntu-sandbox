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
      expect(out).toMatch(/inconnu|introuvable|Incomplete|not-found|Invalid input|Unrecognized command/i);
    });

    it('`name` est indisponible en config-if (mode config-vlan uniquement)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('name Foo');
      expect(out).toMatch(/inconnu|introuvable|Incomplete|not-found|Invalid input|Unrecognized command/i);
    });

    it('`interface` est indisponible en config-vlan', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 10');
      const out = await sw.executeCommand('interface FastEthernet0/1');
      expect(out).toMatch(/inconnu|introuvable|Incomplete|not-found|Invalid input|Unrecognized command/i);
    });
  });

  // ─── Bloc 10 : switchport trunk native ──────────────────────────

  describe('switchport trunk native vlan', () => {
    it('`switchport trunk native vlan 99` positionne trunkNativeVlan=99', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      const out = await sw.executeCommand('switchport trunk native vlan 99');
      expect(out).toBe('');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkNativeVlan).toBe(99);
    });

    it('`switchport trunk native vlan 4095` refuse (hors bornes)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport trunk native vlan 4095');
      expect(out).toMatch(/Invalid input/);
    });

    it('`switchport trunk native` seul est incomplete', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport trunk native');
      expect(out).toMatch(/Incomplete/);
    });
  });

  // ─── Bloc 11 : switchport trunk allowed ─────────────────────────

  describe('switchport trunk allowed vlan (toutes les formes)', () => {
    it('`switchport trunk allowed vlan 10,20,30` positionne exactement 3 VLANs', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('switchport trunk allowed vlan 10,20,30');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkAllowedVlans).toEqual([10, 20, 30]);
    });

    it('`switchport trunk allowed vlan 10-15` développe la plage', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('switchport trunk allowed vlan 10-15');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkAllowedVlans).toEqual([10, 11, 12, 13, 14, 15]);
    });

    it('`switchport trunk allowed vlan none` vide la liste', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('switchport trunk allowed vlan none');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkAllowedVlans).toEqual([]);
    });

    it('`switchport trunk allowed vlan all` réinitialise 1-4094', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('switchport trunk allowed vlan 10');
      await sw.executeCommand('switchport trunk allowed vlan all');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkAllowedVlans.length).toBe(4094);
    });

    it('`switchport trunk allowed vlan add 40` ajoute à la liste existante', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('switchport trunk allowed vlan 10,20');
      await sw.executeCommand('switchport trunk allowed vlan add 40');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkAllowedVlans).toEqual([10, 20, 40]);
    });

    it('`switchport trunk allowed vlan remove 20` retire de la liste existante', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport mode trunk');
      await sw.executeCommand('switchport trunk allowed vlan 10,20,30');
      await sw.executeCommand('switchport trunk allowed vlan remove 20');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.trunkAllowedVlans).toEqual([10, 30]);
    });

    it('liste avec plage inversée `20-10` refuse', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport trunk allowed vlan 20-10');
      expect(out).toMatch(/Invalid input/);
    });

    it('`switchport trunk allowed vlan add junk` refuse (parsing)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport trunk allowed vlan add junk');
      expect(out).toMatch(/Invalid input/);
    });
  });

  // ─── Bloc 12 : no vlan (suppression) ────────────────────────────

  describe('no vlan <id>', () => {
    it('`no vlan 10` supprime le VLAN 10 après création', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 10');
      await sw.executeCommand('exit');
      await sw.executeCommand('no vlan 10');
      expect(machineOf(sw).switch.vlan(10)).toBeNull();
    });

    it('`no vlan 1` refuse (VLAN par défaut non supprimable)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('no vlan 1');
      expect(out).toMatch(/cannot delete default VLAN/);
      expect(machineOf(sw).switch.vlan(1)).not.toBeNull();
    });

    it('`no vlan 999` sur un VLAN absent renvoie un message d\'erreur', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('no vlan 999');
      expect(out).toMatch(/VLAN not found|not found/i);
    });
  });

  // ─── Bloc 13 : interface range (multi-interfaces) ───────────────

  describe('interface range', () => {
    it('`interface range FastEthernet0/1-3` bascule en config-if et broadcast', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('interface range FastEthernet0/1-3');
      expect(out).toBe('');
      expect(sw.getPrompt()).toBe('SW1(config-if)#');
      await sw.executeCommand('switchport mode access');
      await sw.executeCommand('switchport access vlan 42');
      // Les 3 interfaces reçoivent la même config.
      for (const p of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']) {
        const info = machineOf(sw).switch.interface(p);
        expect(info?.mode).toBe('access');
        expect(info?.accessVlan).toBe(42);
      }
      // Un port hors plage n'est pas affecté.
      const untouched = machineOf(sw).switch.interface('FastEthernet0/4');
      expect(untouched?.accessVlan).toBe(1);
    });

    it('`interface range Fa0/1-2, Fa0/10` accepte la syntaxe composée', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface range FastEthernet0/1-2, FastEthernet0/10');
      await sw.executeCommand('shutdown');
      for (const p of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/10']) {
        expect(machineOf(sw).switch.interface(p)?.adminUp).toBe(false);
      }
      // Port hors plage : reste up.
      expect(machineOf(sw).switch.interface('FastEthernet0/3')?.adminUp).toBe(true);
    });

    it('`interface range FastEthernet0/1-99` refuse (interface inexistante)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('interface range FastEthernet0/1-99');
      expect(out).toMatch(/Invalid input/);
      expect(sw.getPrompt()).toBe('SW1(config)#');
    });

    it('`interface range` supporte `description` broadcasté', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface range FastEthernet0/1-2');
      await sw.executeCommand('description Access ports');
      for (const p of ['FastEthernet0/1', 'FastEthernet0/2']) {
        expect(machineOf(sw).switch.interface(p)?.description).toBe('Access ports');
      }
    });

    it('`exit` d\'un range efface `selectedInterfaces` (clearOnExit)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface range FastEthernet0/1-2');
      await sw.executeCommand('exit');
      expect(sw.getPrompt()).toBe('SW1(config)#');
      // Nouveau push simple : la sélection précédente n'affecte pas la
      // nouvelle interface.
      await sw.executeCommand('interface FastEthernet0/3');
      await sw.executeCommand('switchport mode trunk');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.mode).toBe('access');
      expect(machineOf(sw).switch.interface('FastEthernet0/3')?.mode).toBe('trunk');
    });

    it('range avec plage inversée `Fa0/5-3` refuse', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('interface range FastEthernet0/5-3');
      expect(out).toMatch(/Invalid input/);
    });
  });

  // ─── Bloc 14 : abréviations trunk / range ───────────────────────

  describe('Abréviations trunk / range', () => {
    it('`sw tr nat vl 99` résout `switchport trunk native vlan 99`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw tr nat vl 99');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.trunkNativeVlan).toBe(99);
    });

    it('`sw tr al vl 10,20` résout `switchport trunk allowed vlan 10,20`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw tr al vl 10,20');
      expect(machineOf(sw).switch.interface('FastEthernet0/1')?.trunkAllowedVlans).toEqual([10, 20]);
    });

    it('`int ra Fa0/1-2` résout `interface range FastEthernet0/1-2`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('int ra FastEthernet0/1-2');
      expect(sw.getPrompt()).toBe('SW1(config-if)#');
      await sw.executeCommand('shutdown');
      expect(machineOf(sw).switch.interface('FastEthernet0/2')?.adminUp).toBe(false);
    });
  });

  // ─── Bloc 15 : vlan <range/list> (batch creation) ───────────────

  describe('vlan <plage/liste> (création batch en config)', () => {
    it('`vlan 30-35` crée 6 VLANs et RESTE en config (pas de push)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('vlan 30-35');
      expect(out).toBe('');
      expect(sw.getPrompt()).toBe('SW1(config)#');
      for (let v = 30; v <= 35; v++) {
        expect(machineOf(sw).switch.vlan(v)).not.toBeNull();
      }
    });

    it('`vlan 100,200,300` crée 3 VLANs (liste)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 100,200,300');
      expect(sw.getPrompt()).toBe('SW1(config)#');
      for (const v of [100, 200, 300]) {
        expect(machineOf(sw).switch.vlan(v)).not.toBeNull();
      }
    });

    it('`vlan 40` (ID unique) push config-vlan comme avant', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 40');
      expect(sw.getPrompt()).toBe('SW1(config-vlan)#');
      expect(machineOf(sw).switch.vlan(40)).not.toBeNull();
    });

    it('`vlan 30-4095` refuse (borne max)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('vlan 30-4095');
      expect(out).toMatch(/Invalid input/);
    });

    it('`vlan junk` refuse (spec invalide)', async () => {
      const sw = await toConfig();
      const out = await sw.executeCommand('vlan junk');
      expect(out).toMatch(/Invalid input/);
    });

    it('la création batch apparaît dans show vlan brief', async () => {
      const sw = await toConfig();
      await sw.executeCommand('vlan 200,201');
      await sw.executeCommand('end');
      const out = await sw.executeCommand('show vlan brief');
      expect(out).toMatch(/^200\s+VLAN0200\s+active/m);
      expect(out).toMatch(/^201\s+VLAN0201\s+active/m);
    });
  });

  // ─── Bloc 16 : port-security ────────────────────────────────────

  describe('switchport port-security', () => {
    it('`switchport port-security` seul active port-security (default max=1, violation=shutdown)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport port-security');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.enabled).toBe(true);
      expect(info?.portSecurity.maxMac).toBe(1);
      expect(info?.portSecurity.violationMode).toBe('shutdown');
      expect(info?.portSecurity.sticky).toBe(false);
    });

    it('`switchport port-security maximum 4` positionne maxMac=4', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport port-security maximum 4');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.maxMac).toBe(4);
    });

    it('`switchport port-security maximum 0` refuse (au moins 1)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport port-security maximum 0');
      expect(out).toMatch(/Invalid input/);
    });

    it('`switchport port-security violation restrict` positionne violation=restrict', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport port-security violation restrict');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.violationMode).toBe('restrict');
    });

    it('`switchport port-security violation protect` positionne violation=protect', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport port-security violation protect');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.violationMode).toBe('protect');
    });

    it('`switchport port-security violation shutdown` positionne violation=shutdown (défaut)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport port-security violation restrict');
      await sw.executeCommand('switchport port-security violation shutdown');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.violationMode).toBe('shutdown');
    });

    it('`switchport port-security violation` seul est incomplete', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport port-security violation');
      expect(out).toMatch(/Incomplete/);
    });

    it('`switchport port-security mac-address sticky` positionne sticky=true', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('switchport port-security mac-address sticky');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.sticky).toBe(true);
    });

    it('`switchport port-security mac-address` seul est incomplete', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('switchport port-security mac-address');
      expect(out).toMatch(/Incomplete/);
    });

    it('port-security fonctionne aussi en `interface range` (broadcast)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface range FastEthernet0/1-3');
      await sw.executeCommand('switchport port-security');
      await sw.executeCommand('switchport port-security maximum 2');
      for (const p of ['FastEthernet0/1', 'FastEthernet0/2', 'FastEthernet0/3']) {
        const info = machineOf(sw).switch.interface(p);
        expect(info?.portSecurity.enabled).toBe(true);
        expect(info?.portSecurity.maxMac).toBe(2);
      }
    });
  });

  // ─── Bloc 17 : abréviations vlan-range / port-security ──────────

  describe('Abréviations vlan-range / port-security', () => {
    it('`sw po max 5` résout `switchport port-security maximum 5`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw po max 5');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.maxMac).toBe(5);
    });

    it('`sw po m` seul est ambigu (maximum vs mac-address)', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      const out = await sw.executeCommand('sw po m 5');
      expect(out).toMatch(/ambigu|Ambiguous/i);
    });

    it('`sw po v r` résout `switchport port-security violation restrict`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw po v r');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.violationMode).toBe('restrict');
    });

    it('`sw po mac st` résout `switchport port-security mac-address sticky`', async () => {
      const sw = await toConfig();
      await sw.executeCommand('interface FastEthernet0/1');
      await sw.executeCommand('sw po mac st');
      const info = machineOf(sw).switch.interface('FastEthernet0/1');
      expect(info?.portSecurity.sticky).toBe(true);
    });
  });
});

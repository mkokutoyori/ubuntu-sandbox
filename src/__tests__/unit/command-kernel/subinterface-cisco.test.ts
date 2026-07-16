/**
 * Palette dédiée : sous-interfaces Cisco IOS (`interface Gi0/0.N` +
 * `encapsulation dot1Q N [native]`) sur le socle command-kernel.
 *
 * Ces cas ciblent le pipeline single-gate à travers `CliInterpreter` :
 * configuration, lecture d'état (DTO), affichage vendeur (`show ip
 * interface brief`, `show ip route`), négations, transitions de mode
 * et effets de nettoyage (clearOnExit).
 *
 * Toutes les données lues côté test proviennent :
 *   - de la sortie textuelle vendeur (via `executeCommand`) ;
 *   - de la MachineApi (via `getCommandKernelCli().machine`) — jamais
 *     d'un accès direct à l'équipement `Router`/`Port`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { RouterMachineApi } from '@/network/devices/router/command-kernel/RouterMachineApi';

beforeEach(() => {
  resetCounters();
  EquipmentRegistry.resetInstance();
});

/** Accès typé à la MachineApi du routeur pour lire les DTOs — équivalent
 *  au `ctx.machine` que les commandes utilisent, sans exposer le
 *  vendeur `Router`. */
function machineOf(r: CiscoRouter): RouterMachineApi {
  return (r as unknown as { getCommandKernelCli(): { machine: RouterMachineApi } })
    .getCommandKernelCli().machine;
}

/** Prépare un routeur Cisco en mode config prêt à recevoir une
 *  transition `interface X`. */
async function goToConfig(hostname: string = 'R1'): Promise<CiscoRouter> {
  const r = new CiscoRouter(hostname);
  await r.executeCommand('enable');
  await r.executeCommand('configure terminal');
  return r;
}

describe('Cisco routeur — sous-interfaces (command-kernel)', () => {

  // ─── Bloc 1 : création à la volée ────────────────────────────────

  describe('Création à la volée via `interface <parent>.<sub>`', () => {
    it('crée la sous-interface si le parent existe et bascule en config-if', async () => {
      const r = await goToConfig();
      const out = await r.executeCommand('interface GigabitEthernet0/0.10');
      expect(out).toBe('');
      expect(r.getPrompt()).toBe('R1(config-if)#');
      // La sous-interface est bien enregistrée côté MachineApi.
      const info = machineOf(r).router.interface('GigabitEthernet0/0.10');
      expect(info).not.toBeNull();
      expect(info?.parent).toBe('GigabitEthernet0/0');
    });

    it('refuse si le parent est inexistant (message vendeur, reste en config)', async () => {
      const r = await goToConfig();
      const out = await r.executeCommand('interface Fake0/9.10');
      expect(out).toMatch(/Invalid input/);
      expect(r.getPrompt()).toBe('R1(config)#');
      expect(machineOf(r).router.interface('Fake0/9.10')).toBeNull();
    });

    it('accepte des sous-ids arbitraires (0 à 4094)', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.1');
      await r.executeCommand('exit');
      await r.executeCommand('interface GigabitEthernet0/0.4094');
      const m = machineOf(r).router;
      expect(m.interface('GigabitEthernet0/0.1')).not.toBeNull();
      expect(m.interface('GigabitEthernet0/0.4094')).not.toBeNull();
    });

    it('re-entrer sur une sous-interface existante ne la duplique pas', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('exit');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const brief = await (async () => {
        await r.executeCommand('end');
        return r.executeCommand('show ip interface brief');
      })();
      // La sous-interface n'apparaît qu'une seule fois.
      const matches = brief.match(/GigabitEthernet0\/0\.10/g) ?? [];
      expect(matches.length).toBe(1);
    });

    it('plusieurs sous-interfaces distinctes coexistent sur le même parent', async () => {
      const r = await goToConfig();
      for (const sub of [10, 20, 30]) {
        await r.executeCommand(`interface GigabitEthernet0/0.${sub}`);
        await r.executeCommand('exit');
      }
      const m = machineOf(r).router;
      for (const sub of [10, 20, 30]) {
        expect(m.interface(`GigabitEthernet0/0.${sub}`)).not.toBeNull();
      }
    });
  });

  // ─── Bloc 2 : encapsulation dot1Q ────────────────────────────────

  describe('Encapsulation dot1Q', () => {
    it('`encapsulation dot1Q 10` pose type=dot1q, vlan=10, native=false via DTO', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const out = await r.executeCommand('encapsulation dot1Q 10');
      expect(out).toBe('');
      const enc = machineOf(r).router.interface('GigabitEthernet0/0.10')?.encapsulation;
      expect(enc).toEqual({ type: 'dot1q', vlan: 10, native: false });
    });

    it('`encapsulation dot1Q 99 native` positionne native=true', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.99');
      await r.executeCommand('encapsulation dot1Q 99 native');
      const enc = machineOf(r).router.interface('GigabitEthernet0/0.99')?.encapsulation;
      expect(enc).toEqual({ type: 'dot1q', vlan: 99, native: true });
    });

    it('accepte la casse minuscule `dot1q` (alias)', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1q 10');
      const enc = machineOf(r).router.interface('GigabitEthernet0/0.10')?.encapsulation;
      expect(enc?.vlan).toBe(10);
    });

    it('rejette un VLAN hors bornes (< 1 ou > 4094) avec le message vendeur', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const out = await r.executeCommand('encapsulation dot1Q 0');
      expect(out).toMatch(/Invalid input/);
      const enc = machineOf(r).router.interface('GigabitEthernet0/0.10')?.encapsulation;
      expect(enc).toBeNull();
    });

    it('rejette une encapsulation sur une interface principale (non sous-if)', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0');
      const out = await r.executeCommand('encapsulation dot1Q 10');
      expect(out).toMatch(/Invalid input/);
      const enc = machineOf(r).router.interface('GigabitEthernet0/0')?.encapsulation;
      expect(enc).toBeNull();
    });

    it('`encapsulation` seul renvoie « Incomplete command. »', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      const out = await r.executeCommand('encapsulation');
      expect(out).toMatch(/Incomplete/);
    });

    it('remplacer l\'encapsulation existante fonctionne', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1Q 10');
      await r.executeCommand('encapsulation dot1Q 20 native');
      const enc = machineOf(r).router.interface('GigabitEthernet0/0.10')?.encapsulation;
      expect(enc).toEqual({ type: 'dot1q', vlan: 20, native: true });
    });
  });

  // ─── Bloc 3 : configuration L3 sur sous-interface ────────────────

  describe('Configuration L3 sur sous-interface', () => {
    it('`ip address` fonctionne sur une sous-interface (via même setter que principal)', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1Q 10');
      const out = await r.executeCommand('ip address 10.10.10.1 255.255.255.0');
      expect(out).toBe('');
      const info = machineOf(r).router.interface('GigabitEthernet0/0.10');
      expect(info?.ip).toBe('10.10.10.1');
      expect(info?.mask).toBe('255.255.255.0');
    });

    it('`no ip address` retire l\'IP d\'une sous-interface', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1Q 10');
      await r.executeCommand('ip address 10.10.10.1 255.255.255.0');
      await r.executeCommand('no ip address');
      const info = machineOf(r).router.interface('GigabitEthernet0/0.10');
      expect(info?.ip).toBe('');
    });

    it('`description Uplink v10` fonctionne sur une sous-interface', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('description Uplink v10');
      const info = machineOf(r).router.interface('GigabitEthernet0/0.10');
      expect(info?.description).toBe('Uplink v10');
    });

    it('`shutdown` puis `no shutdown` bascule l\'état admin de la sous-interface', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('shutdown');
      let info = machineOf(r).router.interface('GigabitEthernet0/0.10');
      expect(info?.adminUp).toBe(false);
      await r.executeCommand('no shutdown');
      info = machineOf(r).router.interface('GigabitEthernet0/0.10');
      expect(info?.adminUp).toBe(true);
    });
  });

  // ─── Bloc 4 : affichage vendeur ──────────────────────────────────

  describe('Affichage vendeur (show ip interface brief / show ip route)', () => {
    it('`show ip interface brief` liste la sous-interface avec son IP configurée', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ip address 192.168.0.1 255.255.255.0');
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1Q 10');
      await r.executeCommand('ip address 10.10.10.1 255.255.255.0');
      await r.executeCommand('end');
      const brief = await r.executeCommand('show ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\.10\s+10\.10\.10\.1\s+/m);
    });

    it('`show ip route` liste la route connectée via la sous-interface', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0');
      await r.executeCommand('ip address 192.168.0.1 255.255.255.0');
      await r.executeCommand('no shutdown');
      await r.executeCommand('exit');
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1Q 10');
      await r.executeCommand('ip address 10.1.1.1 255.255.255.0');
      await r.executeCommand('end');
      const routes = await r.executeCommand('show ip route');
      expect(routes).toMatch(/^C\s+10\.1\.1\.0\/24 is directly connected, GigabitEthernet0\/0\.10$/m);
    });

    it('une sous-interface sans IP reste `unassigned` dans show ip int brief', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('end');
      const brief = await r.executeCommand('show ip interface brief');
      expect(brief).toMatch(/^GigabitEthernet0\/0\.10\s+unassigned\s+/m);
    });
  });

  // ─── Bloc 5 : transitions de mode et nettoyage ───────────────────

  describe('Transitions de mode / clearOnExit', () => {
    it('`exit` de config-if efface `selectedInterface` (clearOnExit)', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('encapsulation dot1Q 10');
      await r.executeCommand('exit');
      expect(r.getPrompt()).toBe('R1(config)#');
      // Retour sur une autre sous-if : les commandes agissent bien sur
      // la nouvelle sélection, sans résidu de la précédente.
      await r.executeCommand('interface GigabitEthernet0/0.20');
      await r.executeCommand('encapsulation dot1Q 20');
      const encOld = machineOf(r).router.interface('GigabitEthernet0/0.10')?.encapsulation;
      const encNew = machineOf(r).router.interface('GigabitEthernet0/0.20')?.encapsulation;
      expect(encOld?.vlan).toBe(10);
      expect(encNew?.vlan).toBe(20);
    });

    it('`end` depuis config-if revient au mode privileged (exec-level)', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('end');
      expect(r.getPrompt()).toBe('R1#');
    });

    it('les commandes config-if sont indisponibles en config (mode strict)', async () => {
      const r = await goToConfig();
      // On est en config, pas config-if : `encapsulation` n'existe pas.
      const out = await r.executeCommand('encapsulation dot1Q 10');
      expect(out).toMatch(/inconnu|introuvable|Incomplete|indisponible|not-found|Invalid input|Unrecognized command/i);
    });
  });

  // ─── Bloc 6 : abréviations ──────────────────────────────────────

  describe('Abréviations préfixe-unique', () => {
    it('`int Gi0/0.10` résout `interface`', async () => {
      const r = await goToConfig();
      await r.executeCommand('int GigabitEthernet0/0.10');
      expect(r.getPrompt()).toBe('R1(config-if)#');
    });

    it('`enc dot1Q 10` résout `encapsulation`', async () => {
      const r = await goToConfig();
      await r.executeCommand('interface GigabitEthernet0/0.10');
      await r.executeCommand('enc dot1Q 10');
      const enc = machineOf(r).router.interface('GigabitEthernet0/0.10')?.encapsulation;
      expect(enc?.vlan).toBe(10);
    });
  });
});

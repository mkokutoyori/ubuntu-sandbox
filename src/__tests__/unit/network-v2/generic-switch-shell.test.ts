/**
 * Le shell d'un commutateur générique ne plante plus — et ne ment pas.
 *
 * `GenericSwitch` est un commutateur NON MANAGÉ, et pourtant il reçoit le
 * `CiscoSwitchShell` en entier. Or ce shell lit des agents de protocole
 * que seul `CiscoSwitch` construit : DTP, VTP, STP, LACP, UDLD, IGMP
 * snooping. Douze commandes levaient donc `getXxxAgent is not a
 * function` — dont `vlan 10`, c'est-à-dire la fonction première d'un
 * commutateur — et une seule de ces exceptions laissait la CLI coincée
 * dans un mode dont elle ne sortait plus : tout ce qui suivait répondait
 * `% Invalid input`.
 *
 * Le partage est fait selon ce que l'équipement peut honnêtement
 * répondre :
 *
 *   - **Ce qui se déduit de la configuration locale marche pour de
 *     vrai.** La base de VLAN vit sur l'équipement ; VTP ne fait que la
 *     PROPAGER, donc un commutateur sans VTP crée quand même ses VLAN.
 *     De même, un commutateur qui ne parle pas DTP ne négocie rien : son
 *     mode opérationnel EST son mode configuré, ce qui rend `show
 *     interfaces switchport` et `show interfaces trunk` véridiques
 *     plutôt qu'indisponibles.
 *   - **Ce qui exige un protocole que l'équipement ne fait pas tourner
 *     est refusé**, avec les mots d'IOS pour une commande que la
 *     plateforme n'a pas. Ni un tableau décrivant un protocole que
 *     personne ne parle — ce serait un faux — ni une exception.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createSessionForDevice } from '@/terminal/sessions/sessionFactory';
import { CiscoTerminalSession } from '@/terminal/sessions/CiscoTerminalSession';
import { primaryShellKindFor } from '@/shell/shellKind';

const REFUSED = "% Invalid input detected at '^' marker.";

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
});

async function configured(cmds: string[]): Promise<GenericSwitch> {
  const sw = new GenericSwitch('switch-generic', 'GSW', 8, 0, 0);
  sw.powerOn();
  for (const c of ['enable', 'configure terminal', ...cmds]) await sw.executeCommand(c);
  return sw;
}

describe('ce qui se déduit de la configuration locale fonctionne', () => {
  it('`vlan 10` crée vraiment le VLAN — VTP ne fait que le propager', async () => {
    const sw = await configured(['vlan 10', 'name LAB', 'exit', 'end']);

    const out = await sw.executeCommand('show vlan brief');
    expect(out).toContain('10');
    expect(out).toContain('LAB');
    expect(sw.getVLANs().has(10)).toBe(true);
  });

  it('une exception ne coince plus la CLI dans un mode sans issue', async () => {
    const sw = await configured([
      'vtp mode transparent',       // refusée : pas de VTP ici
      'interface eth0',             // …et la session doit continuer
      'description LIEN-LAB',
      'end',
    ]);

    expect(await sw.executeCommand('show running-config')).toContain('description LIEN-LAB');
  });

  it('`show interfaces switchport` répond, sans rien négocier', async () => {
    const sw = await configured(['interface eth0', 'switchport mode trunk', 'end']);

    const out = await sw.executeCommand('show interfaces eth0 switchport');
    expect(out).toContain('Administrative Mode: trunk');
    expect(out).toContain('Operational Mode: trunk');
    // Rien à négocier sans DTP : c'est la vérité d'un port non managé.
    expect(out).toContain('Negotiation of Trunking: Off');
  });

  it('`show interfaces trunk` liste le port réellement configuré en trunk', async () => {
    const sw = await configured(['interface eth0', 'switchport mode trunk', 'end']);

    const out = await sw.executeCommand('show interfaces trunk');
    expect(out).toContain('eth0');
  });

  it('la port-security reste entièrement opérante', async () => {
    const sw = await configured([
      'interface eth0', 'switchport port-security',
      'switchport port-security maximum 2', 'end',
    ]);

    expect(await sw.executeCommand('show port-security interface eth0'))
      .toContain('Port Security              : Enabled');
  });
});

describe('ce qui exige un protocole absent est refusé, pas simulé', () => {
  const CASES: Array<[string, string[]]> = [
    ['show vtp status', []],
    ['show dtp', []],
    ['show udld', []],
    ['show ip igmp snooping', []],
    ['show etherchannel summary', []],
  ];

  for (const [cmd, setup] of CASES) {
    it(`\`${cmd}\` répond comme IOS pour une commande absente`, async () => {
      const sw = await configured([...setup, 'end']);
      expect((await sw.executeCommand(cmd)).trim()).toContain(REFUSED);
    });
  }

  it('les commandes de configuration de ces protocoles sont refusées aussi', async () => {
    const sw = await configured([]);
    for (const cmd of ['vtp mode transparent', 'ip igmp snooping', 'spanning-tree vlan 1 priority 4096']) {
      expect((await sw.executeCommand(cmd)).trim()).toContain(REFUSED);
    }
    await sw.executeCommand('interface eth0');
    for (const cmd of ['switchport mode dynamic auto', 'switchport nonegotiate',
      'channel-group 1 mode active', 'udld port', 'spanning-tree portfast']) {
      expect((await sw.executeCommand(cmd)).trim()).toContain(REFUSED);
    }
  });

  it('un refus ne laisse aucune trace dans la configuration', async () => {
    const sw = await configured([
      'interface eth0', 'switchport mode dynamic auto', 'end',
    ]);

    const run = await sw.executeCommand('show running-config');
    expect(run).not.toContain('dynamic auto');
  });
});

describe('le terminal ouvert est celui du shell que la machine fait tourner', () => {
  it('un commutateur générique ouvre une session IOS, pas bash', () => {
    const sw = new GenericSwitch('switch-generic', 'GSW', 8, 0, 0);
    sw.powerOn();

    // `getOSType()` est lu partout comme « quel dialecte de shell » :
    // `sessionFactory` et `primaryShellKindFor` s'y branchent tous les
    // deux. Répondre « generic » retombait sur le défaut POSIX, donc un
    // commutateur dont l'unique shell est `CiscoSwitchShell` recevait un
    // terminal BASH dans l'UI — `exit` depuis `config-vlan` déconnectait
    // l'opérateur au lieu de remonter d'un niveau.
    expect(sw.getOSType()).toBe('cisco-ios');
    expect(primaryShellKindFor(sw)).toBe('cisco-ios');
    expect(createSessionForDevice(sw, 't')).toBeInstanceOf(CiscoTerminalSession);
  });
});

describe('le vrai Cisco garde toutes ses commandes', () => {
  it('`show vtp status`, `show dtp` et `show etherchannel summary` répondent', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'CSW', 8);
    sw.powerOn();
    await sw.executeCommand('enable');

    for (const cmd of ['show vtp status', 'show dtp', 'show etherchannel summary']) {
      expect((await sw.executeCommand(cmd)).trim()).not.toContain(REFUSED);
    }
  });

  it('`switchport mode dynamic auto` est toujours accepté et rendu', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'CSW', 8);
    sw.powerOn();
    for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/1',
      'switchport mode dynamic auto', 'end']) await sw.executeCommand(c);

    expect(await sw.executeCommand('show running-config'))
      .toContain('switchport mode dynamic auto');
  });
});

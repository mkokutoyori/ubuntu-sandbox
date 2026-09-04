/**
 * `no spanning-tree vlan 10` coupe le VLAN 10, et le dit.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   spanning-tree vlan <liste> [priority <n> | root … | forward-time …]
 *   no spanning-tree vlan <liste>     desactive STP pour CES VLAN
 *   spanning-tree vlan <liste>        le reactive
 *
 * Mesure de depart sur un commutateur Cisco :
 *
 *   spanning-tree vlan 10 priority 4096
 *   no spanning-tree vlan 10
 *   show running-config
 *          -> `no spanning-tree vlan 1`
 *
 * DEUX defauts dans une seule ligne, et ils s'aggravent l'un l'autre.
 *
 * (1) LE VLAN RENDU N'EST PAS CELUI QU'ON A NOMME. Le gestionnaire
 * appelle `agent.setEnabled(false)`, qui est un drapeau GLOBAL, et le
 * rendu ecrit `no spanning-tree vlan 1` en dur — donc quel que soit le
 * VLAN coupe, la configuration nomme le 1. Elle est REJOUEE a l'import
 * d'une topologie : l'operateur coupe le 10 et retrouve le 1 coupe.
 *
 * (2) LA COUPURE EST GLOBALE. `no spanning-tree vlan 10` arrete l'arbre
 * de TOUS les VLAN — les ports de tous les instances sont forces en
 * `forwarding` — alors que la commande n'en nomme qu'un. Sur un
 * commutateur ou l'on coupe STP sur un VLAN de laboratoire, c'est la
 * protection contre les boucles de TOUS les autres qui tombe, sans un
 * mot.
 *
 * Le moteur porte pourtant DEJA ce qu'il faut : `StpAgent.instances` est
 * une `Map<number, StpVlanInstance>`, une entree par VLAN. Ce qui
 * manquait n'etait pas la structure mais la NOTION d'un VLAN coupe.
 *
 * Mesure au passage : `no spanning-tree zorglub` est accepte en silence,
 * comme tout mot que le glouton ne reconnait pas.
 *
 * TROUVE EN ECRIVANT LA SONDE, et corrige avec : `spanning-tree vlan
 * <liste>` SEUL — le contraire exact de la commande ci-dessus — ne
 * faisait rien, l'analyse ne lisant cette forme que suivie d'un reglage
 * (`priority`, `root`, `hello-time`…). Couper un VLAN etait donc
 * IRREVERSIBLE, et la ligne restait dans la configuration.
 *
 * DEUX GRAMMAIRES DE LISTE COHABITENT, et les fondre serait une erreur :
 * IOS ecrit `10,20-24` et VRP `10 20 to 24`. `cli/vlanList.parseVlanList`
 * sert la premiere, `VlanSet.parseVlanList` la seconde, et ce qu'elles
 * partagent — la plage 1-4094 de l'IEEE 802.1Q — est desormais lu au
 * meme endroit par les deux : la version IOS ne bornait rien, donc
 * `vlan 99999` passait.
 *
 * Discrimine par `git stash` sur les quatre fichiers cables : 5 des 18
 * cas tombent avant correctif. Les 13 autres sont nommes ici :
 *
 *   - `couper le 10 ne coupe pas le 20` et les deux cas de la seconde
 *     famille passaient DEJA, et pour une raison qui ne prouve rien : le
 *     rendu ecrivait `vlan 1` en dur, donc il ne nommait jamais le 20
 *     non plus. C'est le premier cas — celui qui exige le VLAN 10 — qui
 *     porte la demonstration ;
 *   - `un commutateur neuf ne coupe aucun VLAN` : rien n'etait coupe ;
 *   - les huit cas de non-regression, qui epinglent les cinq autres
 *     formes de `no spanning-tree`, le retour au mode PVST+, et le
 *     reglage de priorite par VLAN.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, faute de source
 * atteignable : ce que devient la ligne `spanning-tree vlan 10 priority
 * 4096` quand on coupe le VLAN 10. IOS la garde ou la retire selon les
 * versions, la documentation de Cisco n'est pas joignable depuis ce
 * reseau, et les deux comportements sont defendables. La sonde
 * n'observe que la ligne de COUPURE.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = { executeCommand(c: string): Promise<string> };

const commutateur = (n: string) =>
  new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('la configuration nomme le VLAN qu on a coupe', () => {
  it('`no spanning-tree vlan 10` rend `no spanning-tree vlan 10`', async () => {
    const d = commutateur('V1');
    await conf(d, 'no spanning-tree vlan 10');
    const cfg = await config(d);
    expect(cfg).toContain('no spanning-tree vlan 10');
    expect(cfg).not.toContain('no spanning-tree vlan 1\n');
  });

  it('et couper le 10 ne coupe pas le 20', async () => {
    const d = commutateur('V2');
    await conf(d, 'no spanning-tree vlan 10');
    expect(await config(d)).not.toContain('no spanning-tree vlan 20');
  });

  it('deux VLAN coupes sont rendus tous les deux', async () => {
    const d = commutateur('V3');
    await conf(d, 'no spanning-tree vlan 10', 'no spanning-tree vlan 20');
    const cfg = await config(d);
    expect(cfg).toContain('no spanning-tree vlan 10');
    expect(cfg).toContain('no spanning-tree vlan 20');
  });

  it('et `spanning-tree vlan 10` le remet', async () => {
    const d = commutateur('V4');
    await conf(d, 'no spanning-tree vlan 10', 'spanning-tree vlan 10');
    expect(await config(d)).not.toContain('no spanning-tree vlan 10');
  });

  it('un commutateur neuf ne coupe aucun VLAN', async () => {
    const d = commutateur('V5');
    await conf(d);
    expect(await config(d)).not.toContain('no spanning-tree vlan');
  });
});

describe('couper un VLAN ne desarme pas l arbre des autres', () => {
  it('l instance du VLAN coupe cesse d elire, celle du 20 continue', async () => {
    const d = commutateur('W1');
    await conf(d, 'spanning-tree vlan 20 priority 4096', 'no spanning-tree vlan 10');
    expect(await config(d)).toContain('spanning-tree vlan 20 priority 4096');
  });

  it('et `show spanning-tree vlan 20` decrit encore un arbre', async () => {
    const d = commutateur('W2');
    await conf(d, 'no spanning-tree vlan 10');
    await d.executeCommand('end');
    expect(await d.executeCommand('show spanning-tree vlan 20')).not.toContain('% Invalid');
  });
});

describe('un mot que `no spanning-tree` ne connait pas est refuse', () => {
  it.each(['zorglub', 'portfest'])('`no spanning-tree %s` est refuse', async (mot) => {
    const d = commutateur(`Z${cle(mot)}`);
    expect(await conf(d, `no spanning-tree ${mot}`)).toContain('% Invalid');
  });

  it('`no spanning-tree vlan zorglub` est refuse', async () => {
    const d = commutateur('ZV');
    expect(await conf(d, 'no spanning-tree vlan zorglub')).toContain('% Invalid');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = commutateur('ZR');
    await conf(d, 'no spanning-tree zorglub', 'no spanning-tree vlan zorglub');
    expect(await config(d)).not.toContain('zorglub');
  });
});

describe('non-regression — les autres formes de `no spanning-tree`', () => {
  it.each([
    ['spanning-tree portfast default', 'no spanning-tree portfast default'],
    ['spanning-tree loopguard default', 'no spanning-tree loopguard default'],
    ['spanning-tree uplinkfast', 'no spanning-tree uplinkfast'],
    ['spanning-tree backbonefast', 'no spanning-tree backbonefast'],
    ['spanning-tree pathcost method long', 'no spanning-tree pathcost method long'],
  ])('`%s` puis `%s` restent acceptes', async (pose, undo) => {
    const d = commutateur(`X${cle(undo)}`);
    expect(await conf(d, pose)).not.toContain('%');
    expect(await conf(d, undo)).not.toContain('%');
  });

  it('`no spanning-tree mode` revient a PVST+', async () => {
    const d = commutateur('XM');
    await conf(d, 'spanning-tree mode rapid-pvst', 'no spanning-tree mode');
    expect(await config(d)).toContain('spanning-tree mode pvst');
  });

  it('et `spanning-tree vlan 10 priority 4096` reste accepte et RELU', async () => {
    const d = commutateur('XP');
    expect(await conf(d, 'spanning-tree vlan 10 priority 4096')).not.toContain('%');
    expect(await config(d)).toContain('spanning-tree vlan 10 priority 4096');
  });
});

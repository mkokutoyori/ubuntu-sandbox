/*
 * La region MST tenait la liste de VLAN d'une instance comme la CHAINE
 * tapee, relue par un analyseur qui fondait la grammaire d'IOS et celle
 * de VRP et sautait en silence ce qu'il ne comprenait pas.
 *
 * Mesure de depart, a la lecture puis au terminal :
 *  - VRP `instance 1 vlan zorglub` et `instance 1 vlan 5000` etaient
 *    acceptes sans un mot, ranges, et rendus par `display this` ; aucun
 *    VLAN n'etait pour autant associe (regle 6) ;
 *  - `instance 1 vlan 10` puis `instance 1 vlan 20` laissait l'instance 1
 *    avec le seul VLAN 20 : chaque commande REMPLACAIT la liste ;
 *  - un VLAN associe a une deuxieme instance restait aussi dans la
 *    premiere ;
 *  - IOS rendait la liste telle que tapee (`instance 1 vlan 20,10`
 *    donnait `20,10`) ;
 *  - VRP n'avait pas `undo instance` ;
 *  - `display stp region-configuration` affichait toujours l'instance 0
 *    sur `1 to 4094`, quels que soient les VLAN associes ailleurs.
 *
 * L'AUTORITE : Cisco, « instance vlan » (Nexus 7000 Layer 2 Command
 * Reference, et les guides Catalyst) : « The mapping is incremental, not
 * absolute. When you enter a range of VLANs, this range is added to or
 * removed from the existing mapping. » Huawei, « instance » (vue de
 * region MST) : un VLAN ne peut etre associe qu'a une seule instance ;
 * l'associer a une autre defait l'association precedente.
 *
 * Ecrite a l'aveugle contre ces sources, avant de toucher la region.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 11 des 14 cas tombent. Passent des deux cotes les trois TEMOINS : une
 * seule association, rendue telle quelle par IOS comme par VRP (la
 * chaine tapee etait deja la bonne), et `no instance … vlan` d'IOS, qui
 * relisait deja la liste pour en oter des VLAN.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

async function ios(lines: string[]): Promise<CiscoSwitch> {
  const sw = new CiscoSwitch('switch-cisco', 'SW1', 8, 0, 0);
  for (const line of ['enable', 'configure terminal', 'spanning-tree mst configuration', ...lines, 'end']) {
    await sw.executeCommand(line);
  }
  return sw;
}

async function iosMapping(lines: string[]): Promise<string[]> {
  const out = await (await ios(lines)).executeCommand('show spanning-tree mst configuration');
  return out.split('\n').filter((l) => /^\d+\s{2,}\S/.test(l)).map((l) => l.replace(/\s+/, ' '));
}

async function vrp(lines: string[]): Promise<{ sw: HuaweiSwitch; answers: string[] }> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW1', 8, 0, 0);
  await sw.executeCommand('system-view');
  await sw.executeCommand('stp region-configuration');
  const answers: string[] = [];
  for (const line of lines) answers.push(await sw.executeCommand(line));
  return { sw, answers };
}

async function vrpInstanceLines(lines: string[]): Promise<string[]> {
  const { sw } = await vrp(lines);
  return (await sw.executeCommand('display this')).split('\n').filter((l) => /^ instance /.test(l));
}

describe('IOS: the VLANs of an MST instance', () => {
  it('a single mapping is rendered as given — WITNESS', async () => {
    expect(await iosMapping(['instance 1 vlan 10-20'])).toEqual(['0 1-9,21-4094', '1 10-20']);
  });

  it('a second `instance 1 vlan` adds to the first', async () => {
    expect(await iosMapping(['instance 1 vlan 10', 'instance 1 vlan 20'])).toEqual(['0 1-9,11-19,21-4094', '1 10,20']);
  });

  it('a VLAN mapped to another instance leaves the first', async () => {
    expect(await iosMapping(['instance 1 vlan 10-20', 'instance 2 vlan 15']))
      .toEqual(['0 1-9,21-4094', '1 10-14,16-20', '2 15']);
  });

  it('the list is rendered in order, whatever the order typed', async () => {
    expect(await iosMapping(['instance 1 vlan 20,10'])).toEqual(['0 1-9,11-19,21-4094', '1 10,20']);
  });

  it('`no instance … vlan` takes VLANs out of the instance — WITNESS', async () => {
    expect(await iosMapping(['instance 1 vlan 10-20', 'no instance 1 vlan 15']))
      .toEqual(['0 1-9,15,21-4094', '1 10-14,16-20']);
  });

  it('the running configuration carries the same list', async () => {
    const sw = await ios(['instance 1 vlan 10', 'instance 1 vlan 20']);

    expect(await sw.executeCommand('show running-config')).toMatch(/^ instance 1 vlan 10,20$/m);
  });
});

describe('VRP: the VLANs of an MST instance', () => {
  it('a single mapping is rendered as given — WITNESS', async () => {
    expect(await vrpInstanceLines(['instance 1 vlan 10 to 20'])).toEqual([' instance 1 vlan 10 to 20']);
  });

  it('a VLAN that is not a VLAN is refused', async () => {
    const { answers } = await vrp(['instance 1 vlan zorglub', 'instance 1 vlan 5000']);

    expect(answers[0]).toMatch(/^Error: /);
    expect(answers[1]).toMatch(/^Error: /);
  });

  it('and nothing is left in the region', async () => {
    expect(await vrpInstanceLines(['instance 1 vlan zorglub', 'instance 1 vlan 5000'])).toEqual([]);
  });

  it('a second `instance 1 vlan` adds to the first', async () => {
    expect(await vrpInstanceLines(['instance 1 vlan 10 to 12', 'instance 1 vlan 20']))
      .toEqual([' instance 1 vlan 10 to 12 20']);
  });

  it('a VLAN mapped to another instance leaves the first', async () => {
    expect(await vrpInstanceLines(['instance 1 vlan 10 to 20', 'instance 2 vlan 15']))
      .toEqual([' instance 1 vlan 10 to 14 16 to 20', ' instance 2 vlan 15']);
  });

  it('`undo instance … vlan` takes VLANs out of the instance', async () => {
    expect(await vrpInstanceLines(['instance 1 vlan 10 to 20', 'undo instance 1 vlan 15']))
      .toEqual([' instance 1 vlan 10 to 14 16 to 20']);
  });

  it('`undo instance` alone removes the instance', async () => {
    expect(await vrpInstanceLines(['instance 1 vlan 10 to 20', 'instance 2 vlan 30', 'undo instance 1']))
      .toEqual([' instance 2 vlan 30']);
  });

  it('the active region gives instance 0 only what nobody else maps', async () => {
    const { sw } = await vrp(['instance 1 vlan 10 to 20', 'active region-configuration', 'quit']);
    const out = await sw.executeCommand('display stp region-configuration');

    expect(out).toMatch(/^ {2}0 {10}1 to 9 21 to 4094$/m);
    expect(out).toMatch(/^ {2}1 {10}10 to 20$/m);
  });
});

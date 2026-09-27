/*
 * Dans la vue d'un VLAN VRP, `arp`, `ip`, `vlan-type` et `mac-vlan` tapes
 * SEULS etaient acceptes sans un mot, ranges, et rendus dans la
 * configuration.
 *
 * Mesure de depart, sur BON_MAIN_SW de la topologie de l'utilisateur :
 *
 *   vlan 10
 *    name CCO
 *    arp               <- un mot seul, que rien n'evalue
 *
 * Un mot-cle sans son complement ne configure rien. VRP le refuse :
 * « Error: Incomplete command found at '^' position. » — la forme que
 * HUAWEI_ERRORS.INCOMPLETE produit deja pour le reste de la CLI. Le
 * simulateur, lui, rangeait la ligne comme une configuration : un
 * critere range et jamais evalue (regle 6), rendu de surcroit.
 *
 * Ecrite a l'aveugle contre ce fait, avant de lire le gestionnaire.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 7 cas tombent. Passent des deux cotes : le TEMOIN, `name CCO`
 * dans la meme vue, et `mux-vlan` seul, qui est une commande COMPLETE —
 * elle fait du VLAN un VLAN principal et ne prend aucun argument.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

async function inVlan10(): Promise<HuaweiSwitch> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW1', 8, 0, 0);
  for (const c of ['system-view', 'vlan 10']) await sw.executeCommand(c);
  return sw;
}

describe('a keyword alone in the VLAN view is an incomplete command', () => {
  for (const keyword of ['arp', 'ip', 'vlan-type', 'mac-vlan']) {
    it(`\`${keyword}\` alone is refused as incomplete`, async () => {
      const sw = await inVlan10();

      expect(await sw.executeCommand(keyword)).toMatch(/^Error: Incomplete command found at '\^' position\./);
    });
  }

  it('`mux-vlan` takes no argument and stays accepted', async () => {
    const sw = await inVlan10();

    expect(await sw.executeCommand('mux-vlan')).toBe('');
  });

  it('a complete command in the same view is accepted and rendered — WITNESS', async () => {
    const sw = await inVlan10();

    expect(await sw.executeCommand('name CCO')).toBe('');
    await sw.executeCommand('return');
    expect(await sw.executeCommand('display current-configuration')).toMatch(/^vlan 10\n name CCO$/m);
  });

  it('and nothing is left in the configuration', async () => {
    const sw = await inVlan10();
    await sw.executeCommand('arp');
    await sw.executeCommand('return');

    expect(await sw.executeCommand('display current-configuration')).not.toMatch(/^ arp$/m);
  });
});

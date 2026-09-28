/*
 * VRP rendait ses listes de VLAN identifiant par identifiant.
 *
 * Mesure de depart, sur un commutateur VRP a 8 ports : `vlan batch 10 to
 * 12 20` rendait `vlan batch 10 11 12 20` dans `display
 * current-configuration`, et un tronc `port trunk allow-pass vlan 10 to
 * 12` rendait ` port trunk allow-pass vlan 10 11 12`. L'analyseur
 * acceptait deja les deux formes ; seul le rendu les ecrivait autrement
 * que la machine.
 *
 * L'AUTORITE EST HUAWEI : les fichiers de configuration de ses exemples
 * (S series, « Example for Configuring VLANs ») portent `vlan batch 2 to
 * 3` et `port trunk allow-pass vlan 2 to 3` — une suite, meme de deux
 * VLAN, s'ecrit `debut to fin` ; les VLAN isoles restent separes par une
 * espace.
 *
 * Ecrite a l'aveugle contre ces exemples, avant de lire le rendu.
 *
 * Question laissee ouverte : un tronc et un port hybride sont membres du
 * VLAN 1 par defaut, et le simulateur ecrit ce `1` en tete de liste. Que
 * VRP le taise ou non n'est pas attestable d'ici (support.huawei.com et
 * forum.huawei.com sont refuses par le proxy de sortie) : les deux cas
 * concernes admettent ce `1 ` initial et ne jugent que la compaction.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 7 cas tombent. Passent des deux cotes les deux TEMOINS : des VLAN
 * isoles, que l'ancien rendu ecrivait deja un par un, et la relecture de
 * la ligne rendue, l'analyseur acceptant deja les deux formes.
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

async function configured(lines: string[]): Promise<string> {
  const sw = new HuaweiSwitch('switch-huawei', 'HW1', 8, 0, 0);
  for (const line of ['system-view', ...lines, 'return']) await sw.executeCommand(line);
  return sw.executeCommand('display current-configuration');
}

describe('VRP writes a run of VLANs as `first to last`', () => {
  it('`vlan batch` compacts a run and keeps an isolated VLAN apart', async () => {
    expect(await configured(['vlan batch 10 to 12 20'])).toMatch(/^vlan batch 10 to 12 20$/m);
  });

  it('a run of two is a run', async () => {
    expect(await configured(['vlan batch 2 3'])).toMatch(/^vlan batch 2 to 3$/m);
  });

  it('isolated VLANs stay one by one — WITNESS', async () => {
    expect(await configured(['vlan batch 10 20'])).toMatch(/^vlan batch 10 20$/m);
  });

  it('a trunk writes its allowed VLANs the same way', async () => {
    const out = await configured([
      'vlan batch 10 to 12 20',
      'interface GigabitEthernet0/0/1', 'port link-type trunk', 'port trunk allow-pass vlan 10 to 12 20', 'quit',
    ]);

    expect(out).toMatch(/^ port trunk allow-pass vlan (?:1 )?10 to 12 20$/m);
  });

  it('a hybrid port writes its tagged and untagged VLANs the same way', async () => {
    const out = await configured([
      'vlan batch 10 to 13',
      'interface GigabitEthernet0/0/2', 'port link-type hybrid',
      'port hybrid tagged vlan 10 to 11', 'port hybrid untagged vlan 12 to 13', 'quit',
    ]);

    expect(out).toMatch(/^ port hybrid tagged vlan 10 to 11$/m);
    expect(out).toMatch(/^ port hybrid untagged vlan (?:1 )?12 to 13$/m);
  });

  it('DHCP snooping writes its VLANs the same way', async () => {
    const out = await configured([
      'vlan batch 10 to 11', 'dhcp enable', 'dhcp snooping enable', 'dhcp snooping enable vlan 10 to 11',
    ]);

    expect(out).toMatch(/^dhcp snooping enable vlan 10 to 11$/m);
  });

  it('the rendered configuration reads back to the same VLANs — WITNESS', async () => {
    const first = await configured(['vlan batch 10 to 12 20']);
    const line = /^vlan batch .*$/m.exec(first)?.[0] ?? '';

    expect(await configured([line])).toMatch(new RegExp(`^${line}$`, 'm'));
  });
});

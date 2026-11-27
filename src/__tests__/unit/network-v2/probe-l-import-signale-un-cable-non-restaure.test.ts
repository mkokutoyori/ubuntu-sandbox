/*
 * Un fichier rouvert qui perd un cable ne le disait pas.
 *
 * Mesure de depart : le laboratoire Lumiere avait ete exporte avec un routeur Cisco
 * de TROIS ports cable sur un quatrieme (les suites de test supposaient quatre
 * interfaces). Importe par le bouton Import de l'interface, le fichier rendait
 * 33 cables sur 34, `warnings` vide, aucune boite de dialogue : le cable
 * R-HQ Gi0/3 - SW-HQ-DB manquait et rien ne l'annoncait. `importTopology`
 * sautait la liaison quand `buildConnection` rendait null.
 *
 * Une liaison que le fichier porte et que l'import ne peut pas poser est un
 * avertissement, jamais un silence : l'operateur doit savoir que sa topologie
 * n'est pas celle qu'il a enregistree.
 *
 * Discrimine par `git stash push -- src/store` : 2 des 3 cas tombent. Le TEMOIN
 * (un fichier intact se rouvre sans avertissement ni cable perdu) passe des deux cotes.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import type { Equipment } from '@/network/equipment/Equipment';
import { buildConnection, type Connection } from '@/store/networkStore';
import { exportTopology, importTopology, type TopologyExport } from '@/store/topologySerializer';

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  EquipmentRegistry.resetInstance();
  Logger.reset();
});

function twoMachines(): TopologyExport {
  const pc = new LinuxPC('linux-pc', 'PC1', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW1', 8, 0, 0);
  const link = buildConnection(pc, 'eth0', sw, 'eth0', 'ethernet') as Connection;
  const devices = new Map<string, Equipment>([[pc.getId(), pc], [sw.getId(), sw]]);
  return exportTopology('lab', devices, [link]);
}

describe('un cable que le fichier porte et que l import ne pose pas', () => {
  it('TEMOIN — un fichier intact se rouvre sans avertissement ni cable perdu', async () => {
    const result = await importTopology(twoMachines());
    expect(result.warnings).toEqual([]);
    expect(result.connections).toHaveLength(1);
  });

  it('un port qui n existe pas sur ce modele est un avertissement nomme', async () => {
    const topology = twoMachines();
    topology.connections[0].targetInterfaceId = 'eth99';
    const result = await importTopology(topology);
    expect(result.connections).toHaveLength(0);
    expect(result.warnings.join('\n')).toContain('PC1:eth0 - SW1:eth99 was not restored');
  });

  it('un cable dont un equipement manque dans le fichier est un avertissement', async () => {
    const topology = twoMachines();
    topology.devices = topology.devices.filter((device) => device.name !== 'SW1');
    const result = await importTopology(topology);
    expect(result.warnings.join('\n')).toContain('is not in the file');
  });
});

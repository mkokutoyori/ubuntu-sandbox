/*
 * Sauver la topologie pendant qu'une CLI de FortiGate se tient dans un bloc
 * `config` perdait TOUTE la configuration du pare-feu.
 *
 * Mesure de depart, sur la topologie que l'utilisateur a exportee
 * (`lan_with_firewall_fortigate.topology (1).json`, commit 16b70e5aa) : le
 * `runningConfigText` de FW1 ne portait plus que
 *
 *   config firewall address
 *       edit "BONAM_SUBNET"
 *       next
 *   end
 *
 * — ni interfaces, ni politiques, ni routes, ni NAT, la ou l'export
 * precedent les portait toutes. Rechargee, la topologie donnait un FW1 qui
 * jette tout : 45 des 82 cas du banc `user lab` tombaient.
 *
 * LA CAUSE : `FortiGate.managementRunningConfig()` tapait `show` dans le
 * shell INTERACTIF, a l'endroit ou l'operateur l'avait laisse. FortiOS
 * repond a `show` dans un bloc par CE BLOC seulement — c'est sa semantique,
 * et elle est juste pour la CLI. L'export, lui, demande la configuration de
 * la machine, qui ne depend pas de l'endroit ou se tient un terminal.
 *
 * L'ASA avait le meme defaut, en pire : son export tapait `show
 * running-config` dans le shell interactif, qui demarre en mode
 * utilisateur (`FW1>`). Un ASA jamais passe en `enable` exportait donc
 * `% Invalid input detected at '^' marker.` — sa configuration n'etait
 * jamais sauvee.
 *
 * Ecrite a l'aveugle contre ce fait, avant de lire le shell.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 6 cas tombent — les deux exports du FortiGate laisse dans un bloc,
 * et les deux de l'ASA. Passent des deux cotes : le TEMOIN (export a la
 * racine) et la non-regression « l'export ne sort pas l'operateur de son
 * bloc », que l'ancien code respectait deja puisqu'il tapait dans le shell
 * sans le deplacer.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FortiGate } from '@/network/devices/firewall/vendors/fortios/FortiGate';
import { AsaFirewall } from '@/network/devices/firewall/vendors/asa/AsaFirewall';
import { exportTopology } from '@/store/topologySerializer';
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

async function configured(): Promise<FortiGate> {
  const fw = new FortiGate('firewall-fortinet', 'FW1', 0, 0);
  for (const line of [
    'config system interface', 'edit "port1"', 'set ip 192.168.1.99 255.255.255.0', 'next', 'end',
    'config router static', 'edit 1', 'set dst 192.168.30.0 255.255.255.0',
    'set gateway 192.168.20.1', 'set device "port2"', 'next', 'end',
  ]) await fw.executeCommand(line);
  return fw;
}

async function leftInsideAnAddress(fw: FortiGate): Promise<void> {
  for (const line of ['config firewall address', 'edit "BONAM_SUBNET"']) await fw.executeCommand(line);
}

describe('la configuration exportee ne depend pas du terminal', () => {
  it('a la racine, l\'export porte interfaces et routes — TEMOIN', async () => {
    const fw = await configured();

    const text = fw.getRunningConfig();
    expect(text).toMatch(/set ip 192\.168\.1\.99 255\.255\.255\.0/);
    expect(text).toMatch(/set dst 192\.168\.30\.0 255\.255\.255\.0/);
  }, 30000);

  it('CLI laissee dans `edit "BONAM_SUBNET"` : l\'export porte encore tout', async () => {
    const fw = await configured();
    await leftInsideAnAddress(fw);

    const text = fw.getRunningConfig();
    expect(text).toMatch(/set ip 192\.168\.1\.99 255\.255\.255\.0/);
    expect(text).toMatch(/set dst 192\.168\.30\.0 255\.255\.255\.0/);
    expect(text).toMatch(/edit "BONAM_SUBNET"/);
  }, 30000);

  it('l\'export de la topologie aussi', async () => {
    const fw = await configured();
    await leftInsideAnAddress(fw);

    const exported = exportTopology('lab', new Map([[fw.getId(), fw as never]]), []);
    const entry = exported.devices.find((d) => d.name === 'FW1');
    expect(entry?.runningConfigText).toMatch(/set ip 192\.168\.1\.99 255\.255\.255\.0/);
  }, 30000);

  it('et l\'export ne sort pas l\'operateur de son bloc', async () => {
    const fw = await configured();
    await leftInsideAnAddress(fw);
    const before = fw.getPrompt();

    fw.getRunningConfig();

    expect(fw.getPrompt()).toBe(before);
    expect(await fw.executeCommand('show')).not.toMatch(/config system interface/);
  }, 30000);
});

describe('l\'ASA exporte sa configuration quel que soit le mode du terminal', () => {
  it('terminal jamais passe en `enable`', async () => {
    const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);

    expect(fw.getRunningConfig()).toMatch(/^hostname ASA1$/m);
  }, 30000);

  it('terminal rendu au mode utilisateur apres une configuration', async () => {
    const fw = new AsaFirewall('firewall-cisco', 'ASA1', 0, 0);
    for (const line of ['enable', '', 'configure terminal', 'hostname ASA-LAB', 'end', 'disable']) {
      await fw.executeCommand(line);
    }

    expect(fw.getRunningConfig()).toMatch(/^hostname ASA-LAB$/m);
    expect(fw.getPrompt()).toBe('ASA-LAB>');
  }, 30000);
});

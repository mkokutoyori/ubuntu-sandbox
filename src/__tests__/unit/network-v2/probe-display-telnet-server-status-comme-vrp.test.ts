/*
 * `display telnet server status` rendait un texte qu'aucun VRP n'ecrit
 * sur le routeur, et n'existait pas sur le commutateur.
 *
 * Mesure de depart :
 *
 *   routeur        Telnet server: Disabled
 *   commutateur    Error: Unrecognized command found at '^' position.
 *
 * Deux boitiers de la meme famille, deux reponses a la meme question —
 * dont l'une est un refus. Et le routeur n'en disait pas plus : ni l'ACL,
 * ni l'interface source, que les lots precedents rendent pourtant
 * effectives.
 *
 * L'AUTORITE EST LA TRANSCRIPTION CAPTUREE, comme la regle 8 le demande
 * pour une mise en colonnes : `ntc-templates` porte, pour cette commande,
 * `tests/huawei_vrp/display_telnet_server_status/
 * huawei_vrp_display_telnet_server_status.raw` :
 *
 *    TELNET IPv4 server                       :Disable
 *    TELNET IPv6 server                       :Disable
 *    TELNET server port                       :23
 *    TELNET server source address             :0.0.0.0
 *    ACL4 number                              :0
 *    ACL6 number                              :0
 *
 * Une espace en tete, l'intitule sur 41 colonnes, les deux-points colles a
 * la valeur. Chaque champ est lu dans le gestionnaire que les commandes
 * ecrivent ; l'adresse source est celle de l'interface nommee par
 * `telnet server-source -i`, et ACL6 reste a 0 parce que rien, dans le
 * simulateur, ne pose d'ACL IPv6 au serveur Telnet.
 *
 * Ecrite a l'aveugle contre cette capture, avant de lire les vues.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 4 cas tombent. Il n'y a pas de temoin passant des deux cotes, et
 * c'est voulu : le fait mesure est la FORME de la vue, qui n'existait sur
 * aucune des deux plateformes ; les valeurs par defaut du premier cas
 * servent de reference aux valeurs configurees du troisieme.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const CAPTURED_DEFAULT = [
  ' TELNET IPv4 server                       :Disable',
  ' TELNET IPv6 server                       :Disable',
  ' TELNET server port                       :23',
  ' TELNET server source address             :0.0.0.0',
  ' ACL4 number                              :0',
  ' ACL6 number                              :0',
].join('\n');

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function after(
  device: HuaweiRouter | HuaweiSwitch, ...commands: string[]
): Promise<string> {
  await device.executeCommand('system-view');
  for (const c of commands) await device.executeCommand(c);
  await device.executeCommand('return');
  return device.executeCommand('display telnet server status');
}

describe('la vue d\'un boitier neuf est celle de la capture', () => {
  it('sur le routeur', async () => {
    expect(await after(new HuaweiRouter('AR1'))).toBe(CAPTURED_DEFAULT);
  }, 30000);

  it('sur le commutateur', async () => {
    expect(await after(new HuaweiSwitch('switch-huawei', 'SW1', 8))).toBe(CAPTURED_DEFAULT);
  }, 30000);
});

describe('la vue lit ce que les commandes ont ecrit', () => {
  it('sur le routeur : activation, port, source, ACL', async () => {
    const out = await after(new HuaweiRouter('AR1'),
      'interface LoopBack0', 'ip address 1.1.1.1 32', 'quit',
      'acl 2000', 'quit',
      'telnet server enable', 'telnet server port 2323',
      'telnet server-source -i LoopBack0', 'telnet server acl 2000');

    expect(out).toBe([
      ' TELNET IPv4 server                       :Enable',
      ' TELNET IPv6 server                       :Disable',
      ' TELNET server port                       :2323',
      ' TELNET server source address             :1.1.1.1',
      ' ACL4 number                              :2000',
      ' ACL6 number                              :0',
    ].join('\n'));
  }, 30000);

  it('sur le commutateur : l\'activation', async () => {
    const out = await after(new HuaweiSwitch('switch-huawei', 'SW1', 8), 'telnet server enable');

    expect(out.split('\n')[0]).toBe(' TELNET IPv4 server                       :Enable');
  }, 30000);
});

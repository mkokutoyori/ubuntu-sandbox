/*
 * `telnet ipv6 server enable` etait range dans le sac de chaines brutes
 * et disparaissait de la configuration ; une forme inconnue de
 * `telnet server …` etait avalee de la meme facon.
 *
 * Mesure de depart, sur un AR1 en vue systeme :
 *
 *   telnet ipv6 server enable        accepte, sans un mot
 *   display current-configuration    la ligne MANQUE
 *   telnet server zzz                accepte, sans un mot
 *
 * CE QUE LE SIMULATEUR NE SAIT PAS FAIRE, mesure et dit plutot que
 * masque : Telnet n'a pas de transport IPv6 de bout en bout. Le client
 * Linux compose depuis sa premiere adresse IPv4 et repond « Network is
 * unreachable » vers 2001:db8::1, alors que `ping -6` y repond. Le
 * serveur IPv6 ne peut donc pas etre EVALUE. La regle 6 prevoit ce cas :
 * une commande qu'un vrai boitier ACCEPTE et que le moteur ne sait pas
 * honorer peut etre rangee et rendue plutot que refusee — sinon un import
 * de topologie perdrait en silence une ligne que le vrai boitier garde.
 * C'est ce que fait ce lot, et rien de plus : l'etat est range, rendu, et
 * annule par `undo` ; il n'ouvre aucune ecoute.
 *
 * Une forme de `telnet server …` ou de `telnet ipv6 …` que le moteur ne
 * connait pas est, elle, refusee : l'accepter sans la ranger serait le
 * defaut de la regle 6 sous sa forme nue.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 2 des 3 cas tombent — le rendu, et le refus d'une forme inconnue. Le
 * troisieme, « `undo` retire la ligne », passe des deux cotes : avant a
 * vide, la ligne n'ayant jamais ete rendue ; seul son voisin « la ligne
 * est rendue » separe les deux etats.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

async function typed(...commands: string[]): Promise<{ ar1: HuaweiRouter; answers: string[] }> {
  const ar1 = new HuaweiRouter('AR1');
  await ar1.executeCommand('system-view');
  const answers: string[] = [];
  for (const c of commands) answers.push(await ar1.executeCommand(c));
  await ar1.executeCommand('return');
  return { ar1, answers };
}

describe('`telnet ipv6 server enable` est range et rendu', () => {
  it('la configuration courante porte la ligne', async () => {
    const { ar1 } = await typed('telnet ipv6 server enable');

    expect(await ar1.executeCommand('display current-configuration'))
      .toMatch(/telnet ipv6 server enable/);
  }, 30000);

  it('`undo telnet ipv6 server enable` la retire', async () => {
    const { ar1 } = await typed('telnet ipv6 server enable', 'undo telnet ipv6 server enable');

    expect(await ar1.executeCommand('display current-configuration'))
      .not.toMatch(/telnet ipv6 server enable/);
  }, 30000);
});

describe('une forme inconnue est refusee, pas avalee', () => {
  it('`telnet server zzz`', async () => {
    const { answers } = await typed('telnet server zzz');

    expect(answers[0]).toMatch(/^Error:/);
  }, 30000);
});

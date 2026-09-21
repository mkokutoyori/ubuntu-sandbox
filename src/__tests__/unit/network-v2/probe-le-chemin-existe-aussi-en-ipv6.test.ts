/*
 * Le fil porte l'IPv6 ; les clients ne savaient pas le lire.
 *
 * Mesure de depart sur un LAN ou un poste et un serveur partagent
 * `2001:db8::/64` a travers un commutateur, le serveur portant un sshd :
 *
 *   ping6 -c 1 2001:db8::6      64 bytes from 2001:db8::6 ... 0% packet loss
 *   nc -zv -w 1 2001:db8::6 22  Connection to ... 22 port [tcp/*] succeeded!
 *   nc -zv -w 1 2001:db8::6 23  ... failed: Connection refused
 *
 *   telnet 2001:db8::6 22       telnet: ... : No route to host
 *   telnet 2001:db8::6 23       telnet: ... : No route to host
 *   telnet 2001:db8::99 22      telnet: could not resolve 2001:db8::99/22
 *   ssh alice@2001:db8::6       ssh: Could not resolve hostname alice@2001:db8::6
 *
 * L'ICMPv6 passe, la poignee de main TCP passe, et les deux clients
 * d'administration declarent la machine injoignable ou le litteral
 * illisible. Les memes commandes vers la meme machine en IPv4
 * repondent juste, ce qui designe la cause : elle est dans ce que les
 * clients savent d'une ADRESSE, pas dans le reseau.
 *
 * TROIS SITES, UNE SEULE CAUSE — « une adresse est un mot d'IPv4 » :
 *
 *   1. La marche du plan de cables (`findReachableHost`) compare la
 *      destination au seul `port.getIPAddress()`, qui est l'IPv4 du
 *      port. Aucun port ne porte jamais l'adresse cherchee, donc
 *      `isPathReachable` rend faux et tout appelant conclut « No route
 *      to host ». C'est le site qui compte le plus : `ssh` comme
 *      `telnet` passent par lui.
 *   2. Le client telnet demande `IPAddress.tryParse(host)` pour savoir
 *      s'il tient un litteral. La reponse est v4-seulement, donc un
 *      litteral IPv6 est pris pour un NOM, et une destination que
 *      personne ne porte se rend « could not resolve » la ou la meme
 *      situation en IPv4 rend « No route to host ».
 *   3. `RE_USERHOST`, des deux clients ssh, n'admet pas le deux-points
 *      dans la partie hote. `ssh alice@2001:db8::6` n'est donc meme pas
 *      analyse.
 *
 * Le depot porte DEJA la reponse aux deux familles — `parseDialAddress`
 * rend `IPAddress | IPv6Address`, et `findHostByAddress` compare bien
 * les adresses IPv6 d'un port, en normalisant la zone et la casse. Les
 * trois sites se branchent dessus plutot que de reecrire le test.
 *
 * Ecrite a l'aveugle contre ce que font les vraies machines : `telnet`
 * et `ssh` acceptent un litteral IPv6 sans crochets sur la ligne de
 * commande (les crochets ne servent qu'aux URL), et un hote du meme
 * lien est joignable des lors que l'ICMPv6 y repond.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 5 des 11 cas tombent. Les 6 autres sont nommes ici, et aucun ne
 * prouve le mecanisme :
 *
 *  - TEMOINS DU FIL : `ping6` repond et `nc` trouve le 22 ouvert et le
 *    23 ferme. Ils passent des deux cotes — sans eux, « l'IPv6 ne
 *    marche pas » et « les clients ne savent pas la lire » seraient
 *    indiscernables, et c'est eux qui designent la cause comme etant
 *    cote CLIENT.
 *  - NON-REGRESSIONS IPv4 : la meme machine reste joignable en `telnet`
 *    sur son adresse v4, une adresse v4 que personne ne porte reste
 *    « No route to host », et un cable DEBRANCHE reste « No route to
 *    host ». Cette derniere est celle qui tombe si l'on « corrige » la
 *    marche du plan de cables en la rendant permissive : elle mesure
 *    que le chemin est toujours VERIFIE, et non suppose. Son jumeau
 *    IPv6 tombe, lui, parce que le litteral y etait pris pour un nom.
 */
import { describe, it, expect } from 'vitest';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const SERVEUR_V4 = '10.0.10.6';
const SERVEUR_V6 = '2001:db8::6';
const POSTE_V4 = '10.0.10.9';
const POSTE_V6 = '2001:db8::9';
const PERSONNE_V4 = '10.0.10.77';
const PERSONNE_V6 = '2001:db8::99';
const SECRET = 'S3cret';

interface Cmd { executeCommand(c: string): Promise<string> }

const runOn = (d: Cmd, cmds: readonly string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function laboratoire() {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  EquipmentRegistry.resetInstance();

  const poste = new LinuxPC('linux-pc', 'PC', -150, 0);
  const serveur = new LinuxServer('linux-server', 'SRV', 150, 0);
  const commutateur = new GenericSwitch('switch-generic', 'SW', 8, 0, 120);
  commutateur.powerOn(); poste.powerOn(); serveur.powerOn();

  new Cable('a').connect(poste.getPort('eth0')!, commutateur.getPort('eth0')!);
  new Cable('b').connect(serveur.getPorts()[0], commutateur.getPort('eth1')!);

  serveur.getPorts()[0].configureIP(new IPAddress(SERVEUR_V4), new SubnetMask('255.255.255.0'));
  await runOn(poste, [
    'ip link set eth0 up', `ip addr add ${POSTE_V4}/24 dev eth0`,
    `ip -6 addr add ${POSTE_V6}/64 dev eth0`,
  ]);
  await runOn(serveur, [
    'ip link set eth0 up', `ip -6 addr add ${SERVEUR_V6}/64 dev eth0`,
    'useradd -m alice', `echo alice:${SECRET} | chpasswd`,
  ]);

  return { poste, serveur };
}

describe('le fil porte l\'IPv6 — les TEMOINS', () => {
  it('`ping6` traverse', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`ping6 -c 1 ${SERVEUR_V6}`)).toMatch(/0% packet loss/);
  });

  it('`nc` trouve le port 22 ouvert', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`nc -zv -w 1 ${SERVEUR_V6} 22`)).toMatch(/succeeded/);
  });

  it('et le port 23 ferme', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`nc -zv -w 1 ${SERVEUR_V6} 23`))
      .toMatch(/Connection refused/);
  });
});

describe('`telnet` lit un litteral IPv6', () => {
  it('il joint le port qui ECOUTE', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(`telnet ${SERVEUR_V6} 22`);

    expect(sortie).not.toMatch(/No route to host/);
    expect(sortie).toMatch(/SSH-2\.0/);
  });

  it('et dit le refus du port qui n\'ecoute PAS, comme `nc`', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`telnet ${SERVEUR_V6} 23`))
      .toMatch(/Connection refused/);
  });

  it('une adresse que PERSONNE ne porte est un defaut de route, pas un nom', async () => {
    const { poste } = await laboratoire();

    const sortie = await poste.executeCommand(`telnet ${PERSONNE_V6} 22`);

    expect(sortie).not.toMatch(/could not resolve/);
    expect(sortie).toMatch(/No route to host/);
  });
});

describe('`ssh` lit un litteral IPv6', () => {
  it('la commande distante repond', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(
      `sshpass -p ${SECRET} ssh alice@${SERVEUR_V6} hostname`))
      .toMatch(/linux-server/);
  });
});

describe('ce que le correctif ne doit pas casser — les NON-REGRESSIONS', () => {
  it('`telnet` joint toujours la meme machine en IPv4', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`telnet ${SERVEUR_V4} 22`)).toMatch(/SSH-2\.0/);
  });

  it('une adresse IPv4 que personne ne porte reste sans route', async () => {
    const { poste } = await laboratoire();

    expect(await poste.executeCommand(`telnet ${PERSONNE_V4} 22`))
      .toMatch(/No route to host/);
  });

  it('un cable DEBRANCHE reste sans route en IPv4', async () => {
    const { poste } = await laboratoire();
    poste.getPort('eth0')!.getCable()?.disconnect();

    expect(await poste.executeCommand(`telnet ${SERVEUR_V4} 22`))
      .toMatch(/No route to host/);
  });

  it('et le devient en IPv6, au lieu d\'un nom illisible', async () => {
    const { poste } = await laboratoire();
    poste.getPort('eth0')!.getCable()?.disconnect();

    expect(await poste.executeCommand(`telnet ${SERVEUR_V6} 22`))
      .toMatch(/No route to host/);
  });
});

/*
 * `ssh server port` etait accepte et n'allait NULLE PART.
 *
 * Le critere type que la regle 6 refuse, dans sa forme la plus nue : la
 * CLI dit oui, et rien n'est range, rien n'est rendu, rien n'est evalue.
 *
 * Mesure de depart, sur un AR1 ou l'on tape `ssh server port 2222` :
 *
 *   ssh server port 2222            accepte, sans un mot
 *   display current-configuration   la ligne MANQUE
 *   ssh admin@10.0.0.1              la session S'OUVRE     <- sur 22
 *   ssh -p 2222 admin@10.0.0.1      Connection refused     <- rien la
 *
 * L'operateur a deplace le service et la machine repond toujours a
 * l'ancienne porte en refusant la nouvelle, sans jamais avoir dit non.
 *
 * LA CAUSE EST UN TRIPLE DUPLICAT, ET LE PLUS PERMISSIF GAGNAIT. La
 * question « que fait `ssh <...>` en vue systeme ? » avait TROIS
 * declarations, toutes dans le meme trie :
 *
 *   HuaweiVRPShell    registerGreedy('ssh', …)   x2, identiques
 *   HuaweiCommonSecurity  dispatch 'ssh' -> mgmt.configureSsh(args)
 *
 * Les deux premieres ne traitent que `server authentication-retries` et
 * rendent `''` pour tout le reste — elles acceptent n'importe quoi en
 * silence. La troisieme, partagee avec le commutateur, route vers le
 * magasin qui connait `server port`. C'est une des deux premieres qui
 * repondait, d'ou le port avale.
 *
 * Mesure faite en chemin, et elle vaut d'etre dite : corriger la
 * PREMIERE declaration n'a RIEN change au comportement. C'est ce qui a
 * designe la troisieme comme celle qui repond vraiment — un duplicat ne
 * se voit pas en lisant, il se voit en mesurant lequel gagne.
 *
 * Les deux declarations du routeur sont SUPPRIMEES. La dispatch
 * partagee porte desormais la commande entiere : les tentatives, le
 * port, sa borne, et la synchronisation de l'ecoute. Une question, une
 * reponse, pour le routeur comme pour le commutateur.
 *
 * L'AUTORITE EST HUAWEI. Le guide de commandes VRP dit de `ssh server
 * port port-number` : « Using the ssh server port command, you can set
 * the listening port number for the SSH server », le defaut est 22, la
 * valeur permise est 22 ou 1025-65535, `undo ssh server port` restaure
 * le defaut, et « if the listening port number for the SSH server is
 * set to another value, you need to specify the port number during
 * login ». Les trois phrases se mesurent ici, dans cet ordre.
 *
 * LA BORNE ANNONCEE EST UNE BORNE APPLIQUEE. 1024 et en-dessous — hors
 * le 22 lui-meme — sont refuses par le constructeur ; les accepter en
 * silence serait la meme faute une seconde fois, un critere range sans
 * etre evalue.
 *
 * CE QUE CE LOT NE TOUCHE PAS, et c'est deliberе : `ip ssh port` d'IOS
 * n'est PAS la meme commande. Sur IOS elle associe un port a une file
 * `rotary` et ne deplace pas le serveur SSH, qui reste sur 22. Le
 * magasin de port n'est ecrit que par le chemin VRP — verifie — donc
 * faire suivre l'ecoute ne change rien cote Cisco.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire l'ecoute.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 4 des 6 cas tombent — le nouveau port, l'ancien port, la borne, et le
 * rendu de la configuration. Les 2 autres sont nommes ici :
 *
 *  - TEMOIN DU DEFAUT : sans rien configurer, la session s'ouvre sur 22
 *    des DEUX cotes. Sans lui, « le port suit la configuration » et
 *    « le serveur n'ecoute plus nulle part » seraient indiscernables.
 *  - `undo ssh server port` PASSE DES DEUX COTES, et pour des raisons
 *    OPPOSEES — c'est pourquoi il est ecrit. AVANT, il passe a vide :
 *    le port n'avait jamais bouge, donc le 22 repondait de toute facon.
 *    APRES, il passe parce que l'annulation ramene vraiment l'ecoute.
 *    Seul son voisin « l'ancien ne repond plus » distingue les deux
 *    etats ; isole, ce cas-ci ne prouverait rien.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';

const ROUTEUR_IP = '10.0.0.1';
const POSTE_IP = '10.0.0.2';
const SECRET = 'Admin@123';
const PORT_CHOISI = 2222;

beforeEach(() => {
  resetCounters();
  MACAddress.resetCounter();
  resetDeviceCounters();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

async function laboratoire(): Promise<{ ar1: HuaweiRouter; poste: LinuxPC }> {
  const ar1 = new HuaweiRouter('AR1');
  const poste = new LinuxPC('linux-pc', 'PC', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'SW', 4, 0, 0);
  new Cable('c1').connect(ar1.getPort('GE0/0/0')!, sw.getPorts()[0]);
  new Cable('c2').connect(poste.getPort('eth0')!, sw.getPorts()[1]);

  for (const c of [
    'system-view',
    'interface GigabitEthernet 0/0/0',
    `ip address ${ROUTEUR_IP} 24`,
    'undo shutdown', 'quit',
    'rsa local-key-pair create',
    'stelnet server enable',
    'aaa',
    `local-user admin password cipher ${SECRET}`,
    'local-user admin privilege level 15',
    'local-user admin service-type ssh',
    'quit',
    'user-interface vty 0 4',
    'authentication-mode aaa',
    'protocol inbound ssh',
    'quit', 'return',
  ]) await ar1.executeCommand(c);

  await poste.executeCommand(`ifconfig eth0 ${POSTE_IP} netmask 255.255.255.0`);
  return { ar1, poste };
}

const deplacerLePort = (ar1: HuaweiRouter, port: number) =>
  ['system-view', `ssh server port ${port}`, 'return']
    .reduce(async (p, c) => { await p; await ar1.executeCommand(c); },
      Promise.resolve<unknown>(undefined));

const parSsh = (poste: LinuxPC, port?: number) =>
  poste.executeCommand(
    `ssh ${port ? `-p ${port} ` : ''}admin@${ROUTEUR_IP} "display version"`,
    `${SECRET}\n`);

describe('sans rien configurer, le serveur ecoute sur 22 — le TEMOIN', () => {
  it('la session s\'ouvre', async () => {
    const { poste } = await laboratoire();

    expect(await parSsh(poste)).toMatch(/VRP|Huawei|Version/i);
  }, 30000);
});

describe('`ssh server port` deplace l\'ecoute', () => {
  it('le nouveau port repond', async () => {
    const { ar1, poste } = await laboratoire();
    await deplacerLePort(ar1, PORT_CHOISI);

    expect(await parSsh(poste, PORT_CHOISI)).toMatch(/VRP|Huawei|Version/i);
  }, 30000);

  it('et l\'ancien ne repond plus', async () => {
    const { ar1, poste } = await laboratoire();
    await deplacerLePort(ar1, PORT_CHOISI);

    expect(await parSsh(poste)).toMatch(/refused|timed out|No route/i);
  }, 30000);

  it('`undo ssh server port` ramene le service sur 22', async () => {
    const { ar1, poste } = await laboratoire();
    await deplacerLePort(ar1, PORT_CHOISI);
    for (const c of ['system-view', 'undo ssh server port', 'return']) {
      await ar1.executeCommand(c);
    }

    expect(await parSsh(poste)).toMatch(/VRP|Huawei|Version/i);
  }, 30000);
});

describe('la borne annoncee est une borne appliquee', () => {
  it('un port de 1 a 1024 autre que 22 est refuse', async () => {
    const { ar1 } = await laboratoire();

    await ar1.executeCommand('system-view');
    const sortie = await ar1.executeCommand('ssh server port 500');

    expect(sortie).toMatch(/Error|Invalid|Wrong/i);
  }, 30000);
});

describe('ce que le correctif ne doit pas emporter', () => {
  it('la configuration courante porte toujours la ligne — le TEMOIN', async () => {
    const { ar1 } = await laboratoire();
    await deplacerLePort(ar1, PORT_CHOISI);

    expect(await ar1.executeCommand('display current-configuration'))
      .toMatch(new RegExp(`ssh server port ${PORT_CHOISI}`));
  }, 30000);
});

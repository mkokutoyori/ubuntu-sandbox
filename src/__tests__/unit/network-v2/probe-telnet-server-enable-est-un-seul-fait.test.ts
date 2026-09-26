/*
 * Sur un routeur VRP, `telnet server enable` ecrivait un magasin que les
 * vues ne lisent pas.
 *
 * Mesure de depart, sur un AR1 ou l'on tape `telnet server enable` en vue
 * systeme, puis ou l'on relit la machine par ses propres commandes :
 *
 *   display current-configuration   telnet server enable     <- active
 *   display telnet server status    Telnet server: Disabled  <- ETEINT
 *
 * (La vue parle desormais la forme capturee de VRP — `TELNET IPv4
 * server :Enable` — depuis la sonde `probe-display-telnet-server-status-
 * comme-vrp` ; les assertions lisent ce champ-la.)
 *
 * La MEME machine, au MEME instant, repond deux choses opposees a la
 * question « le serveur telnet est-il en service ? ». C'est le defaut que
 * la regle 3 de `CLAUDE.md` nomme, et celui que ce depot referme le plus
 * souvent.
 *
 * LA CAUSE EST UN DUPLICAT DE MAGASIN, pas un defaut de rendu. Le
 * commutateur VRP route `telnet server enable` vers
 * `mgmt.configureTelnet(['server','enable'])`, le magasin que toutes les
 * vues lisent. Le routeur, lui, declare la commande dans une boucle de
 * bascules generiques :
 *
 *     for (const kw of ['ntp-service enable', 'telnet server enable', …])
 *       t.register(kw, …, () => { r._setGlobalToggle(kw…, true); … });
 *
 * et ecrit donc `_getGlobalToggle('telnet server')`, que RIEN ne lit sauf
 * une seconde branche du rendu de configuration. Le meme mot, tape sur
 * deux boitiers de la meme famille, ne va pas au meme endroit.
 *
 * Le magasin generique disparait au profit de celui que les vues lisent.
 * Son unique lecteur — la seconde branche du rendu — disparait avec lui,
 * sans quoi la ligne serait rendue deux fois.
 *
 * L'AUTORITE EST HUAWEI : `telnet server enable` met le serveur Telnet en
 * service, et `display telnet server status` est la vue qui le dit. Deux
 * commandes du meme boitier ne peuvent pas se contredire sur cela.
 *
 * CE QUE CE LOT NE TOUCHE PAS, mesure a l'appui plutot que devine.
 * L'ECOUTE du port 23 ne suit PAS `telnet server enable` : elle est
 * gouvernee par le transport de la vty (`protocol inbound telnet`), et
 * `display tcp status` n'annonce donc pas 23 apres cette seule commande —
 * ni sur le routeur ni sur le commutateur. C'est un TROISIEME magasin
 * pour « telnet est-il servi », et le refermer demande de decider ce que
 * VRP fait quand `telnet server enable` et `protocol inbound` divergent,
 * ce que je ne peux pas sourcer depuis cet environnement (la
 * documentation Huawei est bloquee par le mandataire de sortie). Ce lot
 * ferme la contradiction ENTRE LES VUES, qui ne demande aucune source
 * nouvelle, et laisse l'ecoute telle quelle.
 *
 * L'ANNULATION AVAIT LE MEME DEFAUT, EN MIROIR. Sur le routeur,
 * `undo telnet server enable` passait par la table generique de
 * `cmdUndo` et effacait la bascule — la ligne disparaissait, le magasin
 * que les vues lisent n'etait jamais touche. Sur le COMMUTATEUR, elle
 * etait acceptee sans un mot et la ligne RESTAIT dans la configuration :
 * le critere de la regle 6, accepte et sans effet. L'annulation est
 * desormais declaree UNE fois, dans la dispatch partagee
 * `HuaweiCommonSecurity`, a cote de `undo stelnet` qui y vivait deja, et
 * ecrit le magasin. Une forme qu'elle ne connait pas est refusee avec le
 * curseur de VRP, au lieu d'etre avalee.
 *
 * Ecrite a l'aveugle contre cette reference, avant de lire la boucle.
 *
 * Discriminee contre l'etat d'avant (`git stash push -- src/network`) :
 * 3 des 8 cas tombent — l'etat annonce par le routeur, l'annulation sur
 * le commutateur, et le refus d'une annulation inconnue. Les 5 autres
 * sont nommes ici :
 *
 *  - TEMOIN DU COMMUTATEUR : `telnet server enable` seul met la ligne
 *    dans sa configuration des deux cotes ; sans lui, « l'annulation la
 *    retire » ne se distinguerait pas de « la ligne n'y a jamais ete ».
 *
 *  - TEMOIN DU RENDU : `display current-configuration` porte la ligne des
 *    DEUX cotes. C'est lui qui fait de l'ecart une CONTRADICTION et non
 *    une simple absence — sans lui, « la vue dit eteint » serait juste
 *    une commande qui n'a rien fait.
 *  - TEMOIN DU NEUF : un routeur qui n'a rien tape dit « Disabled » des
 *    deux cotes. Sans lui, un correctif qui renverrait « Enabled » en dur
 *    passerait le cas principal.
 *  - `undo telnet server enable` PASSE DES DEUX COTES, pour des raisons
 *    opposees : avant, a vide, la vue disant « Disabled » quoi qu'on
 *    fasse ; apres, parce que l'annulation ecrit vraiment le magasin que
 *    la vue lit.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
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

async function routeurAvecTelnet(): Promise<HuaweiRouter> {
  const ar1 = new HuaweiRouter('AR1');
  for (const c of ['system-view', 'telnet server enable', 'quit']) {
    await ar1.executeCommand(c);
  }
  return ar1;
}

describe('les deux vues du serveur telnet disent la meme chose', () => {
  it('`display telnet server status` l\'annonce en service', async () => {
    const ar1 = await routeurAvecTelnet();

    expect(await ar1.executeCommand('display telnet server status'))
      .toMatch(/TELNET IPv4 server\s+:Enable$/m);
  }, 30000);

  it('et la configuration courante porte la ligne — le TEMOIN', async () => {
    const ar1 = await routeurAvecTelnet();

    expect(await ar1.executeCommand('display current-configuration'))
      .toMatch(/telnet server enable/);
  }, 30000);

  it('la ligne n\'y figure qu\'une fois', async () => {
    const ar1 = await routeurAvecTelnet();

    const conf = await ar1.executeCommand('display current-configuration');
    expect((conf.match(/telnet server enable/g) ?? []).length).toBe(1);
  }, 30000);
});

describe('ce que le correctif ne doit pas casser', () => {
  it('un routeur NEUF annonce le serveur hors service — le TEMOIN', async () => {
    const neuf = new HuaweiRouter('AR9');

    expect(await neuf.executeCommand('display telnet server status'))
      .toMatch(/TELNET IPv4 server\s+:Disable$/m);
  }, 30000);

  it('`undo telnet server enable` le remet hors service', async () => {
    const ar1 = await routeurAvecTelnet();
    for (const c of ['system-view', 'undo telnet server enable', 'quit']) {
      await ar1.executeCommand(c);
    }

    expect(await ar1.executeCommand('display telnet server status'))
      .toMatch(/TELNET IPv4 server\s+:Disable$/m);
  }, 30000);
});

describe('le commutateur VRP annule aussi ce qu\'il a active', () => {
  it('`undo telnet server enable` retire la ligne de la configuration', async () => {
    const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    for (const c of ['system-view', 'telnet server enable', 'undo telnet server enable', 'quit']) {
      await sw1.executeCommand(c);
    }

    expect(await sw1.executeCommand('display current-configuration'))
      .not.toMatch(/telnet server enable/);
  }, 30000);

  it('et l\'activation seule l\'y met — le TEMOIN', async () => {
    const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    for (const c of ['system-view', 'telnet server enable', 'quit']) await sw1.executeCommand(c);

    expect(await sw1.executeCommand('display current-configuration'))
      .toMatch(/telnet server enable/);
  }, 30000);
});

describe('une forme d\'annulation inconnue est refusee, pas avalee', () => {
  it('`undo telnet zzz` est refuse sur les deux plateformes', async () => {
    const ar1 = new HuaweiRouter('AR1');
    const sw1 = new HuaweiSwitch('switch-huawei', 'SW1', 8);
    await ar1.executeCommand('system-view');
    await sw1.executeCommand('system-view');

    expect(await ar1.executeCommand('undo telnet zzz')).toMatch(/^Error:/);
    expect(await sw1.executeCommand('undo telnet zzz')).toMatch(/^Error:/);
  }, 30000);
});

/**
 * `maximum-paths` (IOS) et `maximum load-balancing` (VRP) bornent
 * vraiment la repartition de charge.
 *
 * ── Le defaut, mesure ───────────────────────────────────────────────
 *
 * L'ECMP de ce depot est REEL : `Router.lookupRoute` collecte toutes les
 * routes a egalite (meme prefixe, meme distance, meme metrique) et les
 * emploie a tour de role. **Le plafond, lui, n'existait pas.** La valeur
 * etait rangee dans SEPT magasins — un par protocole et par constructeur
 * — et **lue par personne** :
 *
 * | Ecriture                                   | Lecteur |
 * |--------------------------------------------|---------|
 * | `repo.rip.maximumPaths` (IOS)              | aucun   |
 * | `eigrp().maximumPaths` (IOS)               | EIGRP seul |
 * | OSPF `extra().maximumPaths` (IOS)          | aucun   |
 * | OSPF `_getOSPFExtraConfig()` (VRP)         | aucun   |
 * | BGP `b.maximumPaths` (VRP)                 | aucun   |
 * | IS-IS `i.maximumPaths` (VRP)               | aucun   |
 * | RIP `ripExtras().maximumPaths` (VRP)       | aucun   |
 *
 * Consequence : **`maximum-paths 1` n'avait aucun effet**. C'est la
 * facon normale de COUPER la repartition, et le premier geste de tout
 * diagnostic de trafic asymetrique — une machine ou ce geste ne change
 * rien enseigne exactement le contraire de ce qu'il faut.
 *
 * Cote VRP le defaut allait plus loin : `maximum load-balancing`
 * n'etait **rendu nulle part**, sur aucun des quatre protocoles, donc
 * perdu au rechargement d'une topologie.
 *
 * ── Les defauts sont ceux du materiel, verifies ─────────────────────
 *
 * **BGP vaut 1** — « by default, BGP installs only the best path to a
 * destination », et Huawei l'ecrit aussi — tandis que les IGP valent
 * **4**. Les aligner tous sur 4 apprendrait qu'un iBGP repartit tout
 * seul, ce qui est faux et couteux. La documentation Huawei ajoute la
 * phrase qui donne son sens a la valeur 1 : « to disable load
 * balancing, set the value of number to 1 ».
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { Cable } from '@/network/hardware/Cable';
import { resetCounters, MACAddress, IPAddress, SubnetMask } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

/**
 * Poser N routes a EGALITE PARFAITE vers le meme prefixe.
 *
 * Elles sont posees directement dans la table plutot que par la CLI :
 * ce que la sonde mesure est le PLAFOND, pas la facon dont un protocole
 * calcule ses chemins, et un vrai laboratoire OSPF a quatre chemins
 * egaux demanderait une topologie qui masquerait le sujet.
 */
function poserRoutes(r: CiscoRouter | HuaweiRouter, type: string, combien: number): void {
  // Une route dont l'interface de sortie n'est pas utilisable est
  // ecartee par `isRouteUsable` — c'est le correctif du lot « route
  // statique et shutdown » — et « utilisable » exige une PORTEUSE, donc
  // un vrai cable. Le brancher plutot que de forcer l'etat garde la
  // sonde du bon cote du predicat partage.
  const sortie = r.getPorts()[0];
  const voisin = new CiscoRouter(`V${++serie}`);
  new Cable(`k${serie}`).connect(sortie, voisin.getPorts()[0]);
  sortie.configureIP(new IPAddress('10.0.0.1'), new SubnetMask('255.255.255.0'));
  sortie.setAdminShutdown(false);
  const nom = sortie.getName();
  const table = (r as unknown as { routingTable: unknown[] }).routingTable;
  for (let i = 0; i < combien; i++) {
    table.push({
      network: new IPAddress('10.9.9.0'),
      mask: new SubnetMask('255.255.255.0'),
      nextHop: new IPAddress(`10.0.${i}.2`),
      iface: nom,
      type, ad: 110, metric: 10,
    });
  }
}

/** Combien de prochains sauts DISTINCTS le plan de donnees emploie-t-il ? */
function sautsEmployes(r: CiscoRouter | HuaweiRouter, tours = 24): Set<string> {
  const lookup = (r as unknown as {
    lookupRoute(d: IPAddress): { nextHop?: IPAddress | null } | null;
  }).lookupRoute.bind(r);
  const vus = new Set<string>();
  for (let i = 0; i < tours; i++) {
    const route = lookup(new IPAddress('10.9.9.9'));
    if (route?.nextHop) vus.add(route.nextHop.toString());
  }
  return vus;
}

describe('le plafond est celui du materiel, et il differe selon le protocole', () => {
  it('un IGP repartit sur QUATRE chemins par defaut, pas plus', async () => {
    const r = new CiscoRouter(`R${++serie}`);
    poserRoutes(r, 'ospf', 6);
    expect(sautsEmployes(r).size).toBe(4);
  });

  it('BGP n\'en emploie qu\'UN par defaut : il ne repartit pas', async () => {
    // « by default, BGP installs only the best path to a destination ».
    // Aligner BGP sur 4 apprendrait qu'un iBGP repartit tout seul.
    const r = new CiscoRouter(`R${++serie}`);
    poserRoutes(r, 'bgp', 4);
    expect(sautsEmployes(r).size).toBe(1);
  });

  it('les routes STATIQUES ne sont bornees par rien, et c\'est voulu', async () => {
    // `maximum-paths` vit sous un processus de routage ; aucune commande
    // ne borne les statiques, donc six chemins statiques a egalite se
    // repartissent tous.
    const r = new CiscoRouter(`R${++serie}`);
    poserRoutes(r, 'static', 6);
    expect(sautsEmployes(r).size).toBe(6);
  });

  it('un seul chemin reste un seul chemin, quel que soit le plafond', async () => {
    const r = new CiscoRouter(`R${++serie}`);
    poserRoutes(r, 'ospf', 1);
    expect(sautsEmployes(r).size).toBe(1);
  });
});

describe('IOS : `maximum-paths` borne pour de vrai', () => {
  async function routeur(cmds: string[]) {
    const r = new CiscoRouter(`C${++serie}`);
    for (const c of ['enable', 'configure terminal', ...cmds, 'end']) {
      await r.executeCommand(c);
    }
    return r;
  }

  it('`maximum-paths 1` sous OSPF COUPE la repartition', async () => {
    // Le cas central : c'est le premier geste d'un diagnostic de trafic
    // asymetrique, et il ne faisait rien.
    const r = await routeur(['router ospf 1', 'maximum-paths 1']);
    poserRoutes(r, 'ospf', 4);
    expect(sautsEmployes(r).size).toBe(1);
  });

  it('`maximum-paths 2` en laisse exactement deux', async () => {
    const r = await routeur(['router ospf 1', 'maximum-paths 2']);
    poserRoutes(r, 'ospf', 5);
    expect(sautsEmployes(r).size).toBe(2);
  });

  it('le plafond d\'un protocole ne deborde pas sur un autre', async () => {
    // Sept magasins pour une decision, c'etait l'occasion de tout
    // confondre en un seul ; le plafond est par PROTOCOLE.
    const r = await routeur(['router ospf 1', 'maximum-paths 1']);
    poserRoutes(r, 'rip', 3);
    expect(sautsEmployes(r).size).toBe(3);
  });

  it('`maximum-paths` sous RIP borne RIP', async () => {
    const r = await routeur(['router rip', 'version 2', 'maximum-paths 2']);
    poserRoutes(r, 'rip', 4);
    expect(sautsEmployes(r).size).toBe(2);
  });

  it('la valeur est rendue par la configuration, donc rejouee', async () => {
    const r = await routeur(['router ospf 1', 'maximum-paths 2']);
    // La commande est acceptee ET relisible : sans cela le plafond
    // disparaitrait au rechargement d'une topologie.
    expect(r.maximumPathsFor('ospf')).toBe(2);
  });

  it('une valeur absurde est ignoree plutot que rangee', async () => {
    const r = await routeur(['router ospf 1', 'maximum-paths 0']);
    expect(r.maximumPathsFor('ospf')).toBe(4);
  });
});

describe('VRP : `maximum load-balancing` borne, et se relit', () => {
  async function routeur(cmds: string[]) {
    const r = new HuaweiRouter(`H${++serie}`);
    for (const c of ['system-view', ...cmds, 'return']) await r.executeCommand(c);
    return r;
  }

  it('`maximum load-balancing 1` sous OSPF coupe la repartition', async () => {
    const r = await routeur(['ospf 1', 'maximum load-balancing 1']);
    poserRoutes(r, 'ospf', 4);
    expect(sautsEmployes(r).size).toBe(1);
  });

  it('sous BGP, elle ACTIVE une repartition desactivee par defaut', async () => {
    // Le sens de la commande cote BGP est l'inverse du cote IGP : elle
    // ouvre au lieu de restreindre, puisque le defaut est 1.
    const r = await routeur(['bgp 65001', 'maximum load-balancing 3']);
    poserRoutes(r, 'bgp', 4);
    expect(sautsEmployes(r).size).toBe(3);
  });

  it('sous IS-IS et sous RIP, chacune borne le sien', async () => {
    const r = await routeur(['isis 1', 'maximum load-balancing 2']);
    poserRoutes(r, 'isis', 5);
    expect(sautsEmployes(r).size).toBe(2);
    const r2 = await routeur(['rip 1', 'maximum load-balancing 2']);
    poserRoutes(r2, 'rip', 5);
    expect(sautsEmployes(r2).size).toBe(2);
  });

  it('la ligne PARAIT dans la configuration BGP — elle n\'y etait pas', async () => {
    // Elle n'etait rendue nulle part sur AUCUN des quatre protocoles,
    // donc perdue au rechargement d'une topologie.
    const r = await routeur(['bgp 65001', 'maximum load-balancing 3']);
    expect(await r.executeCommand('display current-configuration'))
      .toContain('maximum load-balancing 3');
  });

  it('elle parait aussi sous IS-IS, RIP et OSPF', async () => {
    for (const [vue, cible] of [
      ['isis 1', 'maximum load-balancing 2'],
      ['rip 1', 'maximum load-balancing 2'],
      ['ospf 1', 'maximum load-balancing 2'],
    ] as const) {
      const r = await routeur([vue, 'maximum load-balancing 2']);
      expect(await r.executeCommand('display current-configuration'), vue)
        .toContain(cible);
    }
  });
});

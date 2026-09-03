/**
 * Un pool DHCP de VRP porte des adresses et une duree de bail.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   ip pool <nom>
 *     network <adresse> mask { <masque> | <longueur> }
 *     gateway-list <adresse> …
 *     dns-list <adresse> …
 *     excluded-ip-address <debut> [<fin>]
 *     lease { day <jours> [hour <heures>] [minute <minutes>] | unlimited }
 *     static-bind ip-address <adresse> mac-address <mac>
 *
 * Mesure de depart sur un routeur Huawei, en relisant la configuration :
 *
 *   gateway-list zorglub    -> ACCEPTE, et RENDU
 *   dns-list zorglub        -> ACCEPTE, et RENDU
 *   network zorglub mask 24 -> ACCEPTE, et jete
 *   lease day zorglub       -> ACCEPTE, et jete
 *
 * C'est la troisieme vue de VRP a porter cette forme, apres la politique
 * de routage et les vues BGP et OSPF, et la consequence est la meme : la
 * configuration est REJOUEE a l'import d'une topologie, donc une passerelle
 * qui n'est pas une adresse revient telle quelle — et un client qui prend
 * ce bail se voit annoncer une passerelle vers laquelle il ne peut rien
 * emettre.
 *
 * Les deux dernieres sont d'un genre different et pire a leur facon :
 * la commande repond OUI et ne retient RIEN, donc l'operateur croit avoir
 * pose un reseau et le pool n'en a pas.
 *
 * Le controle est pose a la porte du MAGASIN et non a chacune des deux
 * portes qui y menent — `configurePoolRouter`, `configurePoolDNS` et
 * `configurePoolLease` rendaient deja un booleen et ne refusaient rien —
 * donc la porte VRP et la porte IOS sont couvertes par une seule
 * ecriture, et chacune traduit le refus dans les mots de son
 * constructeur. C'est la meme regle que pour les options DHCP et les
 * exclusions malformees, pour la meme raison : un magasin garde par ses
 * appelants finit toujours par en avoir un qui oublie.
 *
 * Ce que la porte VRP garde en propre est ce qui lui appartient :
 * `network 10.0.0.0 mask 24` donne une LONGUEUR la ou le magasin veut un
 * masque pointe, et la traduction est faite la plutot que dans un
 * magasin qui sert les deux constructeurs.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 14 des 24
 * cas tombent avant correctif. Les 10 autres sont nommes ici :
 *
 *   - les HUIT cas de valeur juste — les deux listes d'adresses, la
 *     liste a deux serveurs, les deux formes de masque, les trois durees
 *     de bail : un analyseur qui acceptait TOUT les acceptait deja. Ce
 *     sont les TEMOINS, sans lesquels refuser toute la vue satisferait
 *     la moitie de la sonde ;
 *   - les deux cas de non-regression, dont `excluded-ip-address`, que ce
 *     depot avait deja ferme — et c'est ce qui montre que les quatre
 *     trous etaient des trous dans une vue par ailleurs gardee.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, mesure plutot que
 * suppose : que `lease day 0` soit refuse. VRP l'accepte, et la duree
 * nulle n'est pas un non-sens sur cette plateforme comme elle l'est sur
 * IOS — c'est `lease unlimited` qui exprime l'infini, `day 0` avec des
 * heures ou des minutes exprimant un bail plus court qu'un jour.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
  Logger.clear();
});

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new HuaweiRouter(n) as unknown as Dev;

async function dansLePool(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['system-view', 'dhcp enable', 'ip pool P', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('quit');
  await d.executeCommand('quit');
  return String(await d.executeCommand('display current-configuration'));
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('une passerelle et un serveur de noms sont des adresses', () => {
  const PLACES = ['gateway-list', 'dns-list'];

  it.each(PLACES)('`%s zorglub` est refuse', async (clause) => {
    const d = routeur(`G${cle(clause)}`);
    expect(await dansLePool(d, `${clause} zorglub`)).toContain('Error');
  });

  it.each(PLACES)('`%s 999.1.1.1` est refuse', async (clause) => {
    const d = routeur(`GB${cle(clause)}`);
    expect(await dansLePool(d, `${clause} 999.1.1.1`)).toContain('Error');
  });

  it.each(PLACES)('`%s 10.0.0.1` reste accepte et RELU', async (clause) => {
    const d = routeur(`GO${cle(clause)}`);
    expect(await dansLePool(d, `${clause} 10.0.0.1`)).not.toContain('Error');
    expect(await config(d)).toContain(`${clause} 10.0.0.1`);
  });

  it('`dns-list 10.0.0.1 10.0.0.2` reste accepte', async () => {
    const d = routeur('GM');
    expect(await dansLePool(d, 'dns-list 10.0.0.1 10.0.0.2')).not.toContain('Error');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('GN');
    for (const clause of PLACES) await dansLePool(d, `${clause} zorglub`);
    expect(await config(d)).not.toContain('zorglub');
  });
});

describe('un reseau de pool porte une adresse et un masque', () => {
  it.each(['zorglub', '999.1.1.1'])('`network %s mask 24` est refuse', async (n) => {
    const d = routeur(`N${cle(n)}`);
    expect(await dansLePool(d, `network ${n} mask 24`)).toContain('Error');
  });

  it.each(['zorglub', '33', '255.255.0'])(
    '`network 10.0.0.0 mask %s` est refuse', async (m) => {
      const d = routeur(`NM${cle(m)}`);
      expect(await dansLePool(d, `network 10.0.0.0 mask ${m}`)).toContain('Error');
    });

  it.each(['24', '255.255.255.0'])(
    '`network 10.0.0.0 mask %s` reste accepte et RELU', async (m) => {
      const d = routeur(`NO${cle(m)}`);
      expect(await dansLePool(d, `network 10.0.0.0 mask ${m}`)).not.toContain('Error');
      expect(await config(d)).toContain('network 10.0.0.0');
    });
});

describe('une duree de bail est faite de nombres', () => {
  it.each(['lease day zorglub', 'lease day 1 hour zorglub',
    'lease day 1 hour 2 minute zorglub'])('`%s` est refuse', async (ligne) => {
    const d = routeur(`L${cle(ligne)}`);
    expect(await dansLePool(d, ligne)).toContain('Error');
  });

  it.each(['lease day 1', 'lease day 0 hour 12', 'lease unlimited'])(
    '`%s` reste accepte', async (ligne) => {
      const d = routeur(`LO${cle(ligne)}`);
      expect(await dansLePool(d, ligne)).not.toContain('Error');
    });

  it('et aucun `NaN` n entre dans la configuration', async () => {
    const d = routeur('LN');
    await dansLePool(d, 'lease day zorglub');
    expect(await config(d)).not.toContain('NaN');
  });
});

describe('non-regression — ce que la vue faisait deja', () => {
  it('un pool bien forme reste RELU en entier', async () => {
    const d = routeur('XA');
    await dansLePool(d, 'network 10.0.0.0 mask 24', 'gateway-list 10.0.0.1',
      'dns-list 8.8.8.8', 'lease day 1');
    const cfg = await config(d);
    expect(cfg).toContain('ip pool P');
    expect(cfg).toContain('gateway-list 10.0.0.1');
    expect(cfg).toContain('dns-list 8.8.8.8');
  });

  it('et `excluded-ip-address` reste juge', async () => {
    const d = routeur('XB');
    expect(await dansLePool(d, 'excluded-ip-address zorglub')).toContain('Error');
  });
});

/**
 * Une aire OSPF, un poids BGP et un masque sont des valeurs TYPEES.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   router ospf <n>
 *     network <adresse> <masque generique> area <aire>
 *     default-information originate [metric <n>]
 *     timers throttle spf <depart> <attente> <max>
 *   router bgp <asn>
 *     neighbor <adresse> weight <poids>
 *     network <adresse> mask <masque>
 *   router eigrp <n>
 *     metric weights <tos> <k1> <k2> <k3> <k4> <k5>
 *
 * L'identifiant d'aire OSPF fait TRENTE-DEUX bits (RFC 2328 §A.4.1) et
 * s'ecrit soit en decimal, soit en quadruplet pointe — c'est un fait de
 * protocole. Un masque est un `SubnetMask`. Les autres places attendent
 * des nombres.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   network 10.0.0.0 0.0.0.255 area zorglub
 *          -> ACCEPTE, rendu ` network 10.0.0.0 0.0.0.255 area zorglub`
 *   neighbor 10.0.0.1 weight zorglub
 *          -> ACCEPTE, rendu ` neighbor 10.0.0.1 weight zorglub`
 *   network 10.0.0.0 mask zorglub
 *          -> ACCEPTE, rendu ` network 10.0.0.0 mask zorglub`
 *   default-information originate metric zorglub  -> ACCEPTE
 *   timers throttle spf zorglub 100 200           -> ACCEPTE
 *   metric weights zorglub 1 0 1 0 0              -> ACCEPTE
 *
 * Les trois premieres sont RENDUES, donc rejouees a l'import d'une
 * topologie : une aire qu'aucun routeur ne peut annoncer, un poids qui ne
 * departage rien, et un prefixe BGP dont le masque n'en est pas un.
 *
 * Ce que la sonde ne demande PAS : la borne haute de `weight` et des
 * coefficients K d'EIGRP dependent du constructeur et la documentation de
 * Cisco n'est pas atteignable depuis ce reseau ; elles sont inscrites au
 * `TODO.md` plutot que devinees. Un jeton NON NUMERIQUE, lui, se refuse
 * sans table, et un masque se juge par le type que le depot porte deja.
 *
 * DEUX DEFAUTS DE FORME DIFFERENTE, et les confondre aurait fait rater le
 * second : `area zorglub` et `network ... mask zorglub` etaient ACCEPTES,
 * tandis que `neighbor 10.0.0.1 weight zorglub` etait REFUSE — et rendu
 * dans la configuration quand meme. Le gestionnaire ecrivait l'attribut
 * dans le magasin AVANT de juger la valeur, donc l'operateur voyait une
 * erreur et la configuration gardait la ligne. Refuse-et-range est pire
 * qu'accepte : le message dit que rien n'a ete pose.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 13 des 31
 * cas tombent avant correctif. Les 18 autres sont nommes ici :
 *
 *   - les quatre aires VALIDES et les formes justes d'OSPF, de BGP et
 *     d'EIGRP : elles etaient deja acceptees, et ce sont elles qui
 *     bornent le refus ajoute — sans elles, refuser TOUT satisferait la
 *     sonde ;
 *   - le cas individuel `neighbor ... weight zorglub` : il etait DEJA
 *     refuse ; c'est le cas « rien n'en reste dans la configuration » qui
 *     revele la moitie cachee, et cette paire est la lecon du lot ;
 *   - les huit cas de non-regression (identifiant de processus, adresse
 *     de voisin, `remote-as`, `network`, `variance`) : ils etaient juges
 *     depuis toujours ;
 *   - le processus OSPF complet qui se relit : ce que la famille faisait
 *     deja.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

describe('une aire OSPF est un nombre ou un quadruplet', () => {
  const IMPOSSIBLES = ['zorglub', '10.0.0', '4294967296', '-1', '10abc'];

  it.each(IMPOSSIBLES)('`area %s` est refuse', async (aire) => {
    const d = routeur(`A${IMPOSSIBLES.indexOf(aire)}`);
    expect(await conf(d, 'router ospf 1',
      `network 10.0.0.0 0.0.0.255 area ${aire}`)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('AR');
    await conf(d, 'router ospf 1',
      ...IMPOSSIBLES.map((a) => `network 10.0.0.0 0.0.0.255 area ${a}`));
    expect(await config(d)).not.toContain('zorglub');
  });

  const POSSIBLES = ['0', '1', '4294967295', '0.0.0.1'];

  it.each(POSSIBLES)('`area %s` est accepte et RELU', async (aire) => {
    const d = routeur(`AP${POSSIBLES.indexOf(aire)}`);
    expect(await conf(d, 'router ospf 1',
      `network 10.0.0.0 0.0.0.255 area ${aire}`)).not.toContain('%');
    expect(await config(d)).toContain(`network 10.0.0.0 0.0.0.255 area ${aire}`);
  });
});

describe('les places numeriques d OSPF sont des nombres', () => {
  const MAUVAISES = [
    'default-information originate metric zorglub',
    'timers throttle spf zorglub 100 200',
    'timers throttle spf 100 zorglub 200',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`O${MAUVAISES.indexOf(cmd)}`);
    expect(await conf(d, 'router ospf 1', cmd)).toContain('%');
  });

  it('et les formes justes restent acceptees', async () => {
    const d = routeur('OJ');
    for (const cmd of ['default-information originate metric 50',
      'timers throttle spf 10 100 200']) {
      expect(await conf(d, 'router ospf 1', cmd), cmd).not.toContain('%');
    }
  });
});

describe('un poids BGP et un masque sont typés', () => {
  const MAUVAISES = [
    'neighbor 10.0.0.1 weight zorglub',
    'network 10.0.0.0 mask zorglub',
    'network 10.0.0.0 mask 255.255.999.0',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`B${MAUVAISES.indexOf(cmd)}`);
    expect(await conf(d, 'router bgp 65000', cmd)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('BR');
    await conf(d, 'router bgp 65000', ...MAUVAISES);
    expect(await config(d)).not.toContain('zorglub');
  });

  it('les formes justes restent acceptees et RELUES', async () => {
    const d = routeur('BJ');
    await conf(d, 'router bgp 65000',
      'neighbor 10.0.0.1 remote-as 65001',
      'neighbor 10.0.0.1 weight 100',
      'network 172.16.0.0 mask 255.255.0.0');
    const cfg = await config(d);
    expect(cfg).toContain('neighbor 10.0.0.1 weight 100');
    expect(cfg).toContain('network 172.16.0.0 mask 255.255.0.0');
  });
});

describe('les coefficients EIGRP sont des nombres', () => {
  it('`metric weights zorglub 1 0 1 0 0` est refuse', async () => {
    const d = routeur('E1');
    expect(await conf(d, 'router eigrp 1',
      'metric weights zorglub 1 0 1 0 0')).toContain('%');
  });

  it('`metric weights 0 1 0 1 0 zorglub` est refuse', async () => {
    const d = routeur('E2');
    expect(await conf(d, 'router eigrp 1',
      'metric weights 0 1 0 1 0 zorglub')).toContain('%');
  });

  it('et `metric weights 0 1 0 1 0 0` reste accepte', async () => {
    const d = routeur('E3');
    expect(await conf(d, 'router eigrp 1',
      'metric weights 0 1 0 1 0 0')).not.toContain('%');
  });
});

describe('non-regression — ce que la famille jugeait deja', () => {
  const DEJA: ReadonlyArray<readonly [string, string[]]> = [
    ['ospf id', ['router ospf zorglub']],
    ['ospf network', ['router ospf 1', 'network zorglub 0.0.0.255 area 0']],
    ['bgp asn', ['router bgp zorglub']],
    ['bgp neighbor', ['router bgp 65000', 'neighbor zorglub remote-as 65001']],
    ['bgp remote-as', ['router bgp 65000', 'neighbor 10.0.0.1 remote-as zorglub']],
    ['eigrp id', ['router eigrp zorglub']],
    ['eigrp network', ['router eigrp 1', 'network zorglub']],
    ['eigrp variance', ['router eigrp 1', 'variance zorglub']],
  ];

  it.each(DEJA)('%s reste refuse', async (_nom, cmds) => {
    const d = routeur(`N${DEJA.findIndex(([n]) => n === _nom)}`);
    expect(await conf(d, ...cmds)).toContain('%');
  });

  it('un processus OSPF complet se relit toujours', async () => {
    const d = routeur('NO');
    await conf(d, 'router ospf 1', 'router-id 1.1.1.1',
      'network 10.0.0.0 0.0.0.255 area 0');
    const cfg = await config(d);
    expect(cfg).toContain('router ospf 1');
    expect(cfg).toContain('network 10.0.0.0 0.0.0.255 area 0');
  });
});

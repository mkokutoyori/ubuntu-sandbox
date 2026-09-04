/**
 * Sur VRP aussi, un mot-cle CONNU sans sa suite dit « incomplete ».
 *
 * Le garde-fou de l'aide de ce depot vient d'etre etendu au commutateur
 * Cisco ; VRP n'en a aucun. Ce lot balaie donc les deux machines Huawei
 * de la meme facon — chaque mot que `?` propose est execute — et
 * corrige ce que la mesure trouve. La recolte est PETITE, et le dire
 * importe : la vue system-view des deux machines est honnete de bout en
 * bout, zero faute ; tout est dans la vue d'interface.
 *
 *   [routeur, interface]  igmp   -> `Error: Unrecognized command`
 *                         pim    -> `Error: Unrecognized command`
 *   [commutateur, port physique]
 *          mode / lacp / load-balance / max / least
 *                                -> refuses, mais le caret est pose a la
 *                                   FIN de la ligne au lieu du mot
 *
 * LES DEUX FAMILLES SONT DE NATURE DIFFERENTE.
 *
 * (1) `igmp` et `pim` EXISTENT sur cette interface — `igmp enable` et
 *     `pim sm` fonctionnent — et il leur manque seulement leur suite.
 *     Repondre « ce mot n'existe pas » a un mot que la machine connait
 *     envoie chercher une faute de frappe la ou il n'y en a pas ; VRP,
 *     comme IOS, distingue les deux, et seule la seconde reponse aide.
 *     Le gestionnaire retombait sur son refus de fin de chaine parce
 *     qu'un `args[0]` absent devient `''`, qui n'est aucune
 *     sous-commande.
 *
 * (2) Les cinq du commutateur n'existent VRAIMENT que dans la vue d'une
 *     `Eth-Trunk`, et sur un port physique VRP repond bien qu'il ne
 *     connait pas le mot : le VERDICT etait juste. Ce qui ne l'etait pas
 *     est OU pointe le caret. Le refus etait ecrit a la main quatre fois
 *     (`Error: Unrecognized command "mode lacp-static"`, la forme
 *     d'aucune machine), et `normaliserErreurVrp` le remettait ensuite
 *     dans la forme de VRP en posant le caret A LA FIN de la ligne —
 *     c'est-a-dire apres tout, la ou il n'y a rien a montrer. En passant
 *     par `refuseMotInattenduVrp`, le caret se pose sous le mot qui ne
 *     convient pas, et les quatre ecritures n'en font plus qu'une.
 *
 *     LA MESURE A CORRIGE MA PREMIERE LECTURE ICI : j'avais annonce que
 *     la forme rendue etait la chaine inventee. Elle ne l'etait pas — la
 *     normalisation la reecrivait deja —, et c'est ce qui explique que
 *     dix cas de cette sonde passent des DEUX cotes. Seul le cas du
 *     caret discrimine, et il a ete ajoute pour cela.
 *
 * CE QUE CE LOT NE FAIT DELIBEREMENT PAS : empecher `?` d'OFFRIR ces
 * cinq mots sur un port physique. Le trie d'interface est unique pour
 * les deux genres de port, et le filtrage par contexte n'existe que
 * cote Cisco (`commandVisibleToNow`, qui ne connait que le mode, le
 * privilege et la vue). Le construire pour VRP est un autre lot ;
 * inscrit au `TODO.md`.
 *
 * Discrimine par `git stash` sur les trois fichiers cables : 5 des 25
 * cas tombent avant correctif — les deux mots-cles nus et les trois
 * carets. Les 20 autres sont les TEMOINS, et ils portent beaucoup ici :
 * ce lot ne change AUCUN verdict, seulement la facon de le dire, donc
 * sans eux un correctif qui refuserait ou accepterait autre chose
 * passerait inapercu. Ils epinglent les quatre formes d'`igmp`/`pim`
 * qui marchent, les deux mots vraiment inconnus qui doivent le rester,
 * `undo igmp` nu qui a un sens sans suite, les cinq commandes
 * d'Eth-Trunk sur leur vraie vue, et les deux laboratoires ordinaires.
 *
 * DEUX PREMISSES DE CETTE SONDE ETAIENT FAUSSES, corrigees dans la sonde
 * et non dans le code : `igmp version 3` est REFUSE, et il a raison —
 * IGMPv3 n'est pas modelise et le message le dit — donc ce n'etait pas
 * un temoin ; et le laboratoire de routage restait dans la vue
 * d'interface, ou `ospf 1` n'a rien a faire.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
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

const commutateur = (n: string) =>
  new HuaweiSwitch('switch-huawei', n) as unknown as Dev;
const routeur = (n: string) => new HuaweiRouter(n) as unknown as Dev;

async function dansLaVue(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['system-view', ...cmds]) last = String(await d.executeCommand(c));
  return last;
}

const IF_R = 'interface GigabitEthernet0/0/0';
const IF_S = 'interface GigabitEthernet0/0/1';
const cle = (s: string) => s.replace(/\W/g, '');

describe('un mot-cle connu sans sa suite est INCOMPLET, pas inconnu', () => {
  it.each(['igmp', 'pim'])('`%s` nu rend « Incomplete »', async (mot) => {
    const d = routeur(`I${mot}`);
    const out = await dansLaVue(d, IF_R, mot);
    expect(out).toContain('Incomplete command');
    expect(out).not.toContain('Unrecognized');
  });

  it.each(['igmp enable', 'igmp version 2', 'pim sm', 'pim hello-option dr-priority 10'])(
    '`%s` reste accepte', async (ligne) => {
      const d = routeur(`O${cle(ligne)}`);
      expect(await dansLaVue(d, IF_R, ligne)).not.toContain('Error');
    });

  it.each(['igmp zorglub', 'pim zorglub'])(
    '`%s` reste « Unrecognized » : la, le mot est vraiment inconnu', async (ligne) => {
      const d = routeur(`U${cle(ligne)}`);
      expect(await dansLaVue(d, IF_R, ligne)).toContain('Unrecognized command');
    });

  it('et `undo igmp` nu reste accepte : il a un sens sans suite', async () => {
    const d = routeur('UN');
    await dansLaVue(d, IF_R, 'igmp enable');
    expect(await dansLaVue(d, IF_R, 'undo igmp')).not.toContain('Error');
  });
});

describe('un refus de VRP est ecrit dans les mots de VRP', () => {
  const HORS_TRUNK = ['mode lacp-static', 'lacp preempt enable',
    'load-balance src-dst-ip', 'max active-linknumber 4', 'least active-linknumber 2'];

  it.each(HORS_TRUNK)('`%s` sur un port physique porte le caret de VRP', async (ligne) => {
    const d = commutateur(`P${cle(ligne)}`);
    const out = await dansLaVue(d, IF_S, ligne);
    expect(out).toContain("Unrecognized command found at '^' position.");
    expect(out).not.toContain('Unrecognized command "');
  });

  it.each(HORS_TRUNK)('et `%s` reste accepte sur une Eth-Trunk', async (ligne) => {
    const d = commutateur(`T${cle(ligne)}`);
    expect(await dansLaVue(d, 'interface Eth-Trunk 1', ligne)).not.toContain('Error');
  });

  it('la ligne refusee est ECHOUEE sous le message, comme le fait VRP', async () => {
    const d = commutateur('PE');
    const out = await dansLaVue(d, IF_S, 'mode lacp-static');
    expect(out.split('\n')[1]).toContain('mode lacp-static');
  });

  it.each([['mode lacp-static', 'mode'], ['load-balance src-dst-ip', 'load-balance'],
    ['max active-linknumber 4', 'max']])(
    'et le caret de `%s` pointe le mot fautif, pas la fin de la ligne',
    async (ligne, mot) => {
      const d = commutateur(`PC${cle(ligne)}`);
      const out = await dansLaVue(d, IF_S, ligne);
      const lignes = out.split('\n');
      expect(lignes[2].indexOf('^')).toBe(lignes[1].indexOf(mot));
    });
});

describe('non-regression — la vue system-view des deux machines', () => {
  it('un laboratoire de commutation VRP bien forme reste accepte', async () => {
    const d = commutateur('XA');
    await dansLaVue(d, 'vlan batch 10 20', 'quit', IF_S,
      'port link-type access', 'port default vlan 10');
    expect(await dansLaVue(d, IF_S, 'port default vlan 10')).not.toContain('Error');
  });

  it('et un laboratoire de routage VRP bien forme reste accepte', async () => {
    const d = routeur('XB');
    expect(await dansLaVue(d, IF_R, 'ip address 10.0.0.1 24')).not.toContain('Error');
    expect(await dansLaVue(d, 'quit', 'ospf 1', 'area 0')).not.toContain('Error');
  });
});

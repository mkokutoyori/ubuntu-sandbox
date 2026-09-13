/*
 * Les vues de snooping quittent l'arbre, et leur VLAN devient un type.
 *
 * Un lot anterieur avait fait de `show ip igmp snooping ?` de vrais
 * chemins plutot que des mots affiches a cote d'un glouton. Ils
 * restaient des chemins du TRIE : quatorze — sept vues, deux portees —
 * et le glouton sous chacune acceptait encore n'importe quelle queue.
 *
 *     show ip igmp snooping mrouter zorglub   ->  la table, le mot ignore
 *     show ip igmp snooping vlan 5000         ->  refuse, mais au fond
 *                                                 du rendu
 *
 * Le premier est la faute que ce depot nomme « un critere range sans
 * etre evalue », vue du cote de la lecture : un mot que la commande
 * n'honore pas ne doit pas etre pris pour un filtre. Un operateur qui
 * ecrit `mrouter vlan 10` en croyant restreindre la vue lit la table
 * ENTIERE et n'a rien pour s'en apercevoir.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. une vue rend ce qu'elle rendait — migrer change d'ou vient la
 *      reponse, pas la reponse ;
 *   2. un identifiant de VLAN est un TYPE, refuse a sa place ;
 *   3. un mot que la vue n'evalue pas est REFUSE, et non ignore ;
 *   4. l'EXEC utilisateur et l'EXEC privilegie rendent la meme vue —
 *      ces commandes n'ont jamais demande `enable`.
 *
 * Discriminee contre l'etat d'avant : 6 des 24 cas tombent. Les 18 qui
 * passent des deux cotes sont les TEMOINS, et ils sont ici la charge
 * utile : la migration doit se voir a l'inventaire du trie et NULLE PART
 * ailleurs. Les sept vues rendaient deja leur table, aux DEUX portees,
 * `vlan 10` filtrait deja, `vlan 5000` et `vlan zorglub` etaient deja
 * refuses — un lot anterieur avait ferme l'identifiant de VLAN — et
 * `show ip igmp snooping ?` nommait deja ses quatre suites. Ce sont eux
 * qui disent que rien n'a bouge, pendant que les six autres disent ce
 * qui a ete gagne : le type annonce a sa place, le filtre de `groups`
 * juge comme les autres, les trois queues ignorees desormais refusees,
 * et les deux sous-vues de PIM enfin nommees.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const nomsAnnonces = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1])
      .filter((m): m is string => !!m && m !== '<cr>');

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const VUES = [
  'show ip igmp snooping',
  'show ip igmp snooping groups',
  'show ip igmp snooping mrouter',
  'show ip igmp snooping querier',
  'show ip igmp snooping vlan',
  'show ip pim snooping',
  'show ip pim snooping neighbor',
];

describe('chaque vue rend toujours sa table — les TEMOINS', () => {
  it.each(VUES)('`%s`, en EXEC utilisateur', async (frappe) => {
    const d = await commutateur();
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });

  it.each(VUES)('`%s`, en EXEC privilegie', async (frappe) => {
    const d = await commutateur('enable');
    expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
  });
});

describe('le VLAN est un TYPE, a sa place', () => {
  it('`show ip igmp snooping vlan 10` filtre — le TEMOIN', async () => {
    const d = await commutateur('enable', 'configure terminal',
      'vlan 10', 'exit', 'ip igmp snooping', 'end');
    expect(await d.executeCommand('show ip igmp snooping vlan 10'))
      .not.toMatch(/Invalid|Incomplete/);
  });

  it.each([
    'show ip igmp snooping vlan 5000',
    'show ip igmp snooping vlan zorglub',
    'show ip igmp snooping groups vlan 5000',
  ])('`%s` est refuse', async (frappe) => {
    const d = await commutateur('enable');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });

  it('`show ip igmp snooping vlan ?` annonce le type', async () => {
    const d = await commutateur('enable');
    expect(nomsAnnonces(d.cliHelp('show ip igmp snooping vlan '))).toContain('<1-4094>');
  });
});

describe('un mot que la vue n evalue pas est REFUSE', () => {
  it.each([
    'show ip igmp snooping mrouter zorglub',
    'show ip igmp snooping querier zorglub',
    'show ip pim snooping zorglub',
  ])('`%s`', async (frappe) => {
    const d = await commutateur('enable');
    expect(await d.executeCommand(frappe), frappe).toMatch(/Invalid input/);
  });
});

describe('l aide nomme les sept vues', () => {
  it('`show ip igmp snooping ?`', async () => {
    const d = await commutateur('enable');
    expect(nomsAnnonces(d.cliHelp('show ip igmp snooping ')))
      .toEqual(expect.arrayContaining(['groups', 'mrouter', 'querier', 'vlan']));
  });

  it('`show ip pim snooping ?`', async () => {
    const d = await commutateur('enable');
    expect(nomsAnnonces(d.cliHelp('show ip pim snooping ')))
      .toEqual(expect.arrayContaining(['group', 'neighbor']));
  });
});

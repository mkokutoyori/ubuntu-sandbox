/*
 * Quatre vues `show` restaient sur le trie alors que TOUTE leur famille
 * etait deja passee au socle :
 *
 *   show bfd summary               -> socle
 *   show bfd neighbors             -> trie
 *   show dhcp lease                -> socle
 *   show dhcp server               -> trie
 *   show crypto engine connections -> socle
 *   show crypto engine brief       -> trie
 *   show crypto engine configuration -> trie
 *
 * Une famille repartie sur DEUX moteurs est la forme la plus discrete du
 * defaut que cette campagne ferme : les deux repondent, donc rien ne se
 * voit, jusqu'au jour ou l'un apprend une regle que l'autre ignore. La
 * plage annoncee, l'abreviation, le `<cr>`, le niveau de privilege — tout
 * cela est decide une fois par le socle et une autre fois par le trie.
 *
 * Et chacune etait declaree DEUX FOIS, une par arbre : `registerShowCommands`
 * est appele pour l'arbre utilisateur ET pour l'arbre privilegie. C'est la
 * meme duplication que `ping` portait avant sa migration — deux ecritures
 * d'un meme fait, qui ne restent egales que tant que personne ne touche a
 * l'une des deux.
 *
 * Cette sonde ne change AUCUN rendu. Elle mesure que les quatre vues
 * quittent les deux arbres, qu'elles repondent la meme chose dans les deux
 * modes EXEC depuis une seule declaration, et que leur aide comme leurs
 * refus survivent au transfert.
 *
 * Ce qui n'est PAS corrige ici, faute de source : `show dhcp server` rend
 * « DHCP server enabled. » / « DHCP server disabled. », et `show crypto
 * engine brief` rend « IPSec not configured. ». Aucune de ces deux
 * phrases ne ressemble a ce qu'une vraie machine affiche, mais la mise en
 * page exacte de ces vues n'a pas pu etre atteinte — support/cisco.com
 * est bloque au telechargement par le mandataire de sortie de ce reseau,
 * et la recherche ne rend que des pages voisines. Les rendre autrement
 * serait inventer. Le transfert au socle les laisse donc mot pour mot, et
 * la sonde les EPINGLE pour que le jour ou la source sera atteignable, le
 * cas tombe et rappelle qu'il faut les reecrire.
 *
 * Discriminee contre l'etat d'avant (`git stash`) : UN seul des 22 cas
 * tombe, celui qui compte le depart des quatre vues. C'est la forme
 * normale d'une sonde de MIGRATION et non un aveu de faiblesse : les 21
 * autres sont la pour qu'un transfert qui casserait quelque chose ne
 * passe pas pour un succes. Ils tiennent, un par un, le rendu des quatre
 * vues, leurs trois refus, l'incompletude de `show crypto engine`, les
 * huit annonces d'aide dans les DEUX modes EXEC, et l'egalite mot pour
 * mot des reponses entre EXEC utilisateur et EXEC privilegie — cette
 * derniere etant ce que la declaration unique doit garantir et que deux
 * enregistrements separes ne garantissaient pas.
 *
 * `show bfd neighbors` n'a PAS pu passer par l'adaptateur qui a servi
 * les trois autres, et c'est une mesure a lui seul. L'adaptateur donne a
 * un glouton une place `REST` qui avale toute la queue, puis declare ses
 * suites APRES elle : le chemin obtenu est `show bfd neighbors <reste>
 * details`, ou aucune frappe ne peut atteindre `details`. La commande
 * s'EXECUTE encore (la place `REST` avale le mot et le gestionnaire le
 * lit), mais `?` ne l'annonce plus — l'aide et l'execution cessent de
 * repondre a la meme question. Cette vue est donc declaree a la main,
 * avec un vrai sac d'options, ce qui est aussi ce que le socle apporte
 * de mieux qu'un glouton.
 *
 * Le meme defaut vaut pour TOUTE famille deja migree par l'adaptateur
 * dont le glouton portait des suites — `show traffic-shape statistics`
 * est le temoin verifiable : il s'execute, et `show traffic-shape ?` ne
 * l'annonce pas. Le refermer touche l'adaptateur lui-meme et toutes ses
 * familles ; c'est le lot suivant, pas celui-ci.
 */
import { describe, it, expect } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;

const motsDe = (aide: string): string[] =>
  aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);

let serie = 0;

async function routeur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoRouter(`R${serie++}`, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of prelude) await d.executeCommand(c);
  return d;
}

const VUES = [
  'show bfd neighbors',
  'show dhcp server',
  'show crypto engine brief',
  'show crypto engine configuration',
] as const;

const MODES: ReadonlyArray<readonly [string, string[]]> = [
  ['EXEC utilisateur', []],
  ['EXEC privilegie', ['enable']],
];

describe('les quatre dernieres vues `show` quittent le trie', () => {
  it('aucun arbre du routeur ne les garde', () => {
    const shell = (new CiscoRouter(`RX${serie++}`, 0, 0) as unknown as {
      shell: Record<string, { enumerateExecutablePaths(): string[] } | undefined>;
    }).shell;
    for (const nom of ['userTrie', 'privilegedTrie']) {
      const restants = (shell[nom]?.enumerateExecutablePaths() ?? [])
        .filter((p) => VUES.some((v) => p === v || p.startsWith(`${v} `)));
      expect(restants, `${nom} garde ${restants.join(', ')}`).toEqual([]);
    }
  });
});

describe('une seule declaration sert les deux modes EXEC', () => {
  it.each(VUES)('`%s` rend la meme chose des deux cotes', async (vue) => {
    const utilisateur = await routeur();
    const privilegie = await routeur('enable');
    expect(await privilegie.executeCommand(vue))
      .toBe(await utilisateur.executeCommand(vue));
  });
});

describe('l\'aide survit au transfert', () => {
  describe.each(MODES)('%s', (_nom, prelude) => {
    it('`show bfd ?` annonce toujours ses deux vues', async () => {
      const d = await routeur(...prelude);
      expect(motsDe(d.cliHelp('show bfd ')))
        .toEqual(expect.arrayContaining(['neighbors', 'summary']));
    });

    it('`show bfd neighbors ?` annonce toujours `details`', async () => {
      const d = await routeur(...prelude);
      expect(motsDe(d.cliHelp('show bfd neighbors '))).toContain('details');
    });

    it('`show dhcp ?` annonce toujours ses deux vues', async () => {
      const d = await routeur(...prelude);
      expect(motsDe(d.cliHelp('show dhcp ')))
        .toEqual(expect.arrayContaining(['lease', 'server']));
    });

    it('`show crypto engine ?` annonce toujours ses trois vues', async () => {
      const d = await routeur(...prelude);
      expect(motsDe(d.cliHelp('show crypto engine ')))
        .toEqual(expect.arrayContaining(['brief', 'configuration', 'connections']));
    });
  });
});

describe('le rendu et les refus sont ceux d\'avant', () => {
  it('`show bfd neighbors` rend son en-tete', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('show bfd neighbors')).toMatch(/NeighAddr/);
  });

  it('`show bfd neighbors details` reste accepte', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('show bfd neighbors details'))
      .not.toMatch(/Invalid input|Incomplete/);
  });

  it('`show dhcp server` rend son etat', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('show dhcp server')).toMatch(/DHCP server (en|dis)abled\./);
  });

  it.each(['show crypto engine brief', 'show crypto engine configuration'])(
    '`%s` rend son etat', async (vue) => {
      const d = await routeur('enable');
      expect(await d.executeCommand(vue)).toMatch(/IPSec not configured\./);
    });

  it('`show crypto engine` reste INCOMPLET', async () => {
    const d = await routeur('enable');
    expect(await d.executeCommand('show crypto engine')).toMatch(/Incomplete command/);
  });

  it.each([
    'show bfd neighbors zorglub',
    'show dhcp server zorglub',
    'show crypto engine brief zorglub',
  ])('`%s` reste refuse', async (ligne) => {
    const d = await routeur('enable');
    expect(await d.executeCommand(ligne), ligne).toMatch(/Invalid input/);
  });
});

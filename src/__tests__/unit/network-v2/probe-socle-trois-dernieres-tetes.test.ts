/*
 * Les TROIS dernieres frappes qu'un Catalyst promettait de valider sans
 * le tenir, et ce qu'elles ouvrent.
 *
 * Le balayage de l'aide a ete promene sur un Catalyst a profondeur
 * quatre, en configuration d'interface, en configuration de VLAN et en
 * EXEC privilegie. Il en restait trois, une par branche :
 *
 *     private-vlan association ?          ->  <cr>  puis % Incomplete
 *     test aaa group ?                    ->  <cr>  puis % Incomplete
 *     test etherchannel load-balance ?    ->  <cr>  puis % Incomplete
 *
 * Chacune est un glouton sans place : l'arite se deduit des places, et
 * zero place vaut arite zero.
 *
 * `private-vlan` en portait une seconde, d'une autre famille. Son aide
 * DECRIVAIT FAUX :
 *
 *     private-vlan ?
 *       association  Association configuration
 *       community    SNMP community string        <- celle d'ailleurs
 *       isolated     Isolated private VLAN
 *       primary      Primary
 *
 * « SNMP community string » est la description du mot `community` d'une
 * AUTRE commande, ramassee par derivation. Un VLAN communautaire n'a rien
 * d'une chaine SNMP, et c'est precisement ce qu'une aide derivee du code
 * plutot que declaree finit par dire.
 *
 * cisco.com est bloque au telechargement par le mandataire de sortie de
 * ce reseau. Ce que la sonde exige ne demande aucune citation :
 *
 *   1. `?` n'annonce `<cr>` que la ou la frappe VALIDE ;
 *   2. ce que le moteur JUGE, l'aide le NOMME — les trois roles d'un
 *      VLAN prive, les deux codes d'appel de `test aaa group`, la cle de
 *      repartition d'un faisceau ;
 *   3. une description decrit CETTE commande.
 *
 * Ce que la sonde n'exige PAS : la mise en page d'IOS, ni le libelle
 * exact d'un role de VLAN prive. Elle exige qu'aucune description ne
 * parle de SNMP la ou il est question de VLAN — ce qui ne demande aucune
 * reference, seulement de lire ce que la machine repond.
 *
 * Discriminee contre l'etat d'avant : 6 des 16 cas tombent. Les 10 qui
 * passent des deux cotes sont les TEMOINS, et ils portent ici la moitie
 * du sens, parce que ces trois familles ETAIENT deja justes a
 * l'execution — seule leur description l'ignorait :
 *
 *   - `private-vlan ?` ne promettait deja pas `<cr>` et nommait deja ses
 *     quatre mots. C'est le temoin le plus instructif du lot : une aide
 *     peut etre complete, triee, et FAUSSE — `community` y etait decrit
 *     comme une chaine SNMP, et seule la lecture de la ligne le disait ;
 *   - les trois roles, l'association d'un VLAN secondaire et
 *     `test aaa group` complet s'executaient deja. Trois declarations
 *     remplacent trois gloutons sans que la reponse change ;
 *   - les trois refus — un role invente, la forme NOMMEE de `test aaa
 *     group` que le tutoriel croyait bonne, et un faisceau inexistant —
 *     tenaient deja et tiennent encore. Le dernier borne la place
 *     `<1-64>` ajoutee au numero de port-channel : une borne ne doit pas
 *     avaler le refus plus precis du gestionnaire.
 */
import { describe, it, expect } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';

type Cli = {
  executeCommand: (c: string) => Promise<string>;
  cliHelp: (s: string) => string;
  powerOn: () => void;
};

const MOT = /^\s\s(\S+)/;
const mots = (aide: string): string[] =>
  aide.includes('Invalid input') ? []
    : aide.split('\n').map((l) => MOT.exec(l)?.[1]).filter((m): m is string => !!m);
const nomsAnnonces = (aide: string): string[] =>
  mots(aide).filter((m) => m !== '<cr>');
const annonceCr = (aide: string): boolean =>
  aide.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;

async function commutateur(...prelude: string[]): Promise<Cli> {
  const d = new CiscoSwitch('switch-cisco', `X${serie++}`, 8, 0, 0) as unknown as Cli;
  d.powerOn();
  for (const c of ['enable', ...prelude]) await d.executeCommand(c);
  return d;
}

const VLAN = ['configure terminal', 'vlan 100'];

describe('les trois tetes ne promettent plus `<cr>`', () => {
  it.each([
    ['private-vlan association', VLAN],
    ['private-vlan', VLAN],
    ['test aaa group', []],
    ['test etherchannel load-balance', []],
  ] as Array<[string, string[]]>)('`%s ?`', async (frappe, prelude) => {
    const d = await commutateur(...prelude);
    expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? promet <cr>`).toBe(false);
    expect(await d.executeCommand(frappe), frappe).toMatch(/Incomplete command/);
  });
});

describe('l aide NOMME ce que le moteur juge', () => {
  it('`private-vlan ?` nomme les trois roles et l association', async () => {
    const d = await commutateur(...VLAN);
    expect(nomsAnnonces(d.cliHelp('private-vlan ')))
      .toEqual(['association', 'community', 'isolated', 'primary']);
  });

  it('`private-vlan ?` ne parle pas de SNMP', async () => {
    const d = await commutateur(...VLAN);
    expect(d.cliHelp('private-vlan '), 'une description vient d ailleurs')
      .not.toMatch(/SNMP/i);
  });

  /*
   * Le meme defaut vu du rang au-dessus : un noeud sans commande herite
   * de la description de son PREMIER descendant, donc `private-vlan`
   * s'annoncait par les mots de son association — une de ses branches
   * pour le nom de toutes.
   */
  it('`?` decrit `private-vlan` par la famille, pas par une branche', async () => {
    const d = await commutateur(...VLAN);
    const ligne = d.cliHelp('').split('\n')
      .find((l) => /^\s\s+private-vlan\s/.test(l)) ?? '';
    expect(ligne, 'private-vlan n est pas annonce').not.toBe('');
    expect(ligne, 'la famille est decrite par une seule de ses branches')
      .not.toMatch(/Associate secondary/);
  });

  /*
   * `config-vlan` est le PREMIER sous-mode dont l'arbre est vide : tout
   * ce qu'on y tape vient du socle. C'est la mesure du but — « a la fin
   * on ne doit plus avoir un trie » — prise sur le premier mode qui y
   * arrive, et le cas qui le dira si une commande y revient par
   * l'ancien moteur.
   */
  it('l arbre de `config-vlan` est VIDE', async () => {
    const d = await commutateur(...VLAN);
    const shell = (d as unknown as {
      getShell?: () => { getActiveTrie(): { enumerateExecutablePaths(): string[] } };
    });
    const trie = shell.getShell?.();
    expect(trie, 'le shell ne s expose pas').toBeTruthy();
    expect(trie!.getActiveTrie().enumerateExecutablePaths()).toEqual([]);
  });

  it('`name VENTES` renomme le VLAN, et la vue le relit', async () => {
    const d = await commutateur(...VLAN);
    expect(annonceCr(d.cliHelp('name '))).toBe(false);
    expect(await d.executeCommand('name')).toMatch(/Incomplete command/);
    expect(await d.executeCommand('name VENTES')).not.toMatch(/Invalid|Incomplete/);
    await d.executeCommand('end');
    expect(await d.executeCommand('show vlan')).toMatch(/VENTES/);
  });

  it('`test aaa group ... ?` nomme les deux codes d appel', async () => {
    const d = await commutateur();
    expect(nomsAnnonces(d.cliHelp('test aaa group GRP jb secret ')))
      .toEqual(expect.arrayContaining(['legacy', 'new-code']));
  });

  it('`test etherchannel load-balance ?` nomme `interface`', async () => {
    const d = await commutateur();
    expect(nomsAnnonces(d.cliHelp('test etherchannel load-balance ')))
      .toContain('interface');
  });
});

describe('les formes COMPLETES gardent leur `<cr>` et s executent', () => {
  it.each(['private-vlan primary', 'private-vlan isolated', 'private-vlan community'])(
    '`%s`', async (frappe) => {
      const d = await commutateur(...VLAN);
      expect(annonceCr(d.cliHelp(`${frappe} `)), `${frappe} ? tait <cr>`).toBe(true);
      expect(await d.executeCommand(frappe), frappe).not.toMatch(/Invalid|Incomplete/);
    });

  it('`private-vlan association 101` s execute — le TEMOIN', async () => {
    const d = await commutateur('configure terminal',
      'vlan 101', 'private-vlan isolated', 'exit', 'vlan 100', 'private-vlan primary');
    expect(annonceCr(d.cliHelp('private-vlan association 101 '))).toBe(true);
    expect(await d.executeCommand('private-vlan association 101'))
      .not.toMatch(/Invalid|Incomplete/);
  });

  it('`test aaa group GRP jb secret new-code` s execute — le TEMOIN', async () => {
    const d = await commutateur();
    expect(annonceCr(d.cliHelp('test aaa group GRP jb secret new-code '))).toBe(true);
    expect(await d.executeCommand('test aaa group GRP jb secret new-code'))
      .not.toMatch(/Incomplete command/);
  });
});

describe('ce que le moteur refusait, il le refuse encore — les TEMOINS', () => {
  it('`private-vlan zorglub` est refuse', async () => {
    const d = await commutateur(...VLAN);
    expect(await d.executeCommand('private-vlan zorglub')).toMatch(/Invalid|Incomplete/);
  });

  it('la forme NOMMEE de `test aaa group` reste refusee', async () => {
    const d = await commutateur();
    expect(await d.executeCommand(
      'test aaa group GRP username jb password x new-code')).toMatch(/Invalid input/);
  });

  it('`test etherchannel load-balance` sur un groupe inconnu reste refuse', async () => {
    const d = await commutateur();
    expect(await d.executeCommand(
      'test etherchannel load-balance interface port-channel 9 ip 1.1.1.1 2.2.2.2'))
      .toMatch(/does not exist/);
  });
});

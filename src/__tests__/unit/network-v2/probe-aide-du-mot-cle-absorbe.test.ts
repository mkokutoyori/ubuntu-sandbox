/**
 * Ce que `?` annonce apres un mot-cle ABSORBE est ce que ce mot-cle prend.
 *
 * Sonde ecrite contre la reference IOS, avant tout correctif :
 *
 *   aaa session-id { common | unique }              choix OBLIGATOIRE
 *   spanning-tree backbonefast                      AUCUN argument
 *   spanning-tree uplinkfast [ max-update-rate <0-32000> ]
 *
 * Mesure de depart :
 *
 *   aaa session-id ?              -> `WORD  AAA configuration` puis `<cr>`
 *   aaa session-id                -> `% Incomplete command.`
 *   spanning-tree backbonefast ?  -> extend, loopguard, mode, mst,
 *                                    pathcost, portfast, priority,
 *                                    uplinkfast, vlan, <cr>
 *   spanning-tree uplinkfast ?    -> backbonefast, extend, loopguard,
 *                                    mode, mst, pathcost, portfast,
 *                                    priority, vlan, <cr>
 *   spanning-tree backbonefast extend -> `% Invalid input`
 *
 * CE SONT LES DEUX MEMES DEFAUTS, et ils sont a MOI : les deux lots
 * precedents ont rendu ces analyseurs VERIDIQUES — `aaa session-id`
 * exige desormais son mot, `spanning-tree backbonefast` refuse le mot de
 * trop — et ont laisse l'aide promettre ce qu'ils refusent. Les deux
 * garde-fous du depot l'ont dit tout de suite : « un mot que `?` propose
 * existe » et « un `<cr>` annonce se valide vraiment ». Un analyseur
 * rendu exact sans son aide n'est pas une amelioration : c'est un
 * mensonge deplace de l'execution vers la frappe, et c'est la frappe que
 * l'apprenant lit.
 *
 * UNE AFFIRMATION DE MON PROPRE MESSAGE DE COMMIT ETAIT FAUSSE, et la
 * mesure la corrige ici plutot que de la laisser courir : le lot
 * `uplinkfast` ecrivait « `spanning-tree uplinkfast ?` offre
 * `max-update-rate` ». Il ne l'a JAMAIS offert. Ce que `?` rendait apres
 * `uplinkfast` etait la liste des SOEURS de la commande — `backbonefast`,
 * `extend`, `portfast`, `mode`… — c'est-a-dire les enfants du noeud
 * `spanning-tree`, reproposes un cran plus bas. Le mot qui compte,
 * `max-update-rate`, etait le seul absent.
 *
 * LA CAUSE EST UNE ET ELLE EST STRUCTURELLE. `backbonefast`, `uplinkfast`
 * et `session-id` ne sont des noeuds NULLE PART : un gestionnaire glouton
 * (`spanning-tree`, `aaa`) les absorbe. L'aide, restee sur le noeud
 * glouton, y reproposait ses propres enfants, et le repli de dernier
 * recours ajoutait un `WORD` portant la description du PARENT. Le
 * mecanisme pour le dire existe deja et il est nomme dans l'en-tete de
 * `describeArgumentTypes` : `describeArgs` cree le noeud PUREMENT
 * INDICATIF sous le glouton, `takesNoArgument` fait disparaitre le
 * `WORD`. Ce lot ne l'invente pas, il l'APPLIQUE a trois mots-cles qui
 * l'avaient manque — et etend `takesNoArgument`, qui exigeait un noeud
 * DEJA existant, a la creation indicative que sa jumelle faisait deja.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que les autres mots
 * de la famille `spanning-tree` cessent de reproposer leurs soeurs. Le
 * releve dit qu'ils sont onze a etre absorbes par le meme glouton, et
 * les fermer tous demande de mesurer, un par un, ce que chacun prend
 * VRAIMENT — c'est un lot en soi, inscrit au `TODO.md`. Ce lot ferme les
 * trois que ses deux predecesseurs ont ouverts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

async function enConfig<T extends Dev>(d: T): Promise<T> {
  for (const c of ['enable', 'configure terminal']) await d.executeCommand(c);
  return d;
}

const commutateur = (n: string) =>
  enConfig(new CiscoSwitch('switch-cisco', n) as unknown as Dev);
const routeur = (n: string) => enConfig(new CiscoRouter(n) as unknown as Dev);

function mots(aide: string): string[] {
  return aide.split('\n').map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((m) => m.length > 0);
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('`aaa session-id ?` annonce le choix, pas un mot quelconque', () => {
  it('offre `common` et `unique`', async () => {
    const d = await routeur('A1');
    expect(mots(d.cliHelp('aaa session-id '))).toEqual(['common', 'unique']);
  });

  it('n annonce PAS `<cr>`, la commande seule etant incomplete', async () => {
    const d = await routeur('A2');
    expect(mots(d.cliHelp('aaa session-id '))).not.toContain('<cr>');
    expect(String(await d.executeCommand('aaa session-id')))
      .toContain('% Incomplete command.');
  });

  it('n annonce PAS `WORD`, la place n acceptant pas un nom', async () => {
    const d = await routeur('A3');
    expect(mots(d.cliHelp('aaa session-id '))).not.toContain('WORD');
    expect(String(await d.executeCommand('aaa session-id zorglub')))
      .toContain('% Invalid input');
  });

  it.each(['common', 'unique'])('et `aaa session-id %s` reste accepte', async (v) => {
    const d = await routeur(`A${v}`);
    expect(String(await d.executeCommand(`aaa session-id ${v}`))).not.toContain('%');
  });
});

describe('`spanning-tree backbonefast ?` ne repropose pas ses soeurs', () => {
  it('n offre que `<cr>`', async () => {
    const d = await commutateur('B1');
    expect(mots(d.cliHelp('spanning-tree backbonefast '))).toEqual(['<cr>']);
  });

  it.each(['uplinkfast', 'extend', 'portfast', 'mode', 'vlan', 'priority'])(
    'et n offre pas `%s`', async (mot) => {
      const d = await commutateur(`B${mot}`);
      expect(mots(d.cliHelp('spanning-tree backbonefast '))).not.toContain(mot);
    });
});

describe('`spanning-tree uplinkfast ?` annonce le debit et lui seul', () => {
  it('offre `max-update-rate` et `<cr>`', async () => {
    const d = await commutateur('C1');
    expect(mots(d.cliHelp('spanning-tree uplinkfast ')))
      .toEqual(['max-update-rate', '<cr>']);
  });

  it.each(['backbonefast', 'extend', 'portfast', 'mode'])(
    'et n offre pas `%s`', async (mot) => {
      const d = await commutateur(`C${mot}`);
      expect(mots(d.cliHelp('spanning-tree uplinkfast '))).not.toContain(mot);
    });

  it('`spanning-tree uplinkfast max-update-rate ?` annonce la plage', async () => {
    const d = await commutateur('C2');
    expect(d.cliHelp('spanning-tree uplinkfast max-update-rate ')).toContain('<0-32000>');
  });
});

describe('tout mot annonce apres ces trois prefixes s execute', () => {
  const PREFIXES: readonly string[] = [
    'spanning-tree backbonefast', 'spanning-tree uplinkfast', 'aaa session-id',
  ];

  it.each(PREFIXES)('`%s ?` ne promet rien que la machine refuse', async (prefixe) => {
    const commutateurLa = prefixe.startsWith('spanning-tree');
    const aide = commutateurLa
      ? (await commutateur(`D${cle(prefixe)}`)).cliHelp(`${prefixe} `)
      : (await routeur(`D${cle(prefixe)}`)).cliHelp(`${prefixe} `);
    const menteurs: string[] = [];
    for (const mot of mots(aide)) {
      const d = commutateurLa
        ? await commutateur(`E${cle(prefixe + mot)}`)
        : await routeur(`E${cle(prefixe + mot)}`);
      const ligne = mot === '<cr>' ? prefixe : `${prefixe} ${mot}`;
      const out = String(await d.executeCommand(ligne));
      if (/% Invalid input/.test(out)) menteurs.push(`${ligne} -> ${out.trim()}`);
    }
    expect(menteurs).toEqual([]);
  });
});

describe('non-regression — les voisins gardent leur aide', () => {
  /*
   * Le `<cr>` que ce cas attendait d'abord etait un MENSONGE, et c'est
   * la migration de la famille au socle qui l'a retire : `spanning-tree
   * portfast` SEUL est une commande d'INTERFACE, et en configuration
   * globale la machine repond « % Incomplete command. » — le cas
   * l'epingle desormais des deux cotes plutot que d'exiger une aide qui
   * promettait une frappe refusee.
   */
  it('`spanning-tree portfast ?` garde ses quatre suites', async () => {
    const d = await commutateur('F1');
    expect(mots(d.cliHelp('spanning-tree portfast ')))
      .toEqual(['bpdufilter', 'bpduguard', 'default', 'edge']);
    expect(String(await d.executeCommand('spanning-tree portfast')))
      .toContain('% Incomplete command.');
  });

  it('`spanning-tree ?` garde la famille', async () => {
    const d = await commutateur('F2');
    const offerts = mots(d.cliHelp('spanning-tree '));
    for (const attendu of ['backbonefast', 'uplinkfast', 'portfast', 'mode', 'vlan']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });

  it('`aaa ?` garde ses sept fonctions', async () => {
    const d = await routeur('F3');
    expect(mots(d.cliHelp('aaa '))).toEqual([
      'accounting', 'authentication', 'authorization', 'group',
      'local', 'new-model', 'session-id',
    ]);
  });

  it.each(['spanning-tree backbonefast', 'spanning-tree uplinkfast',
    'spanning-tree uplinkfast max-update-rate 100'])(
    '`%s` reste accepte', async (ligne) => {
      const d = await commutateur(`G${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('%');
    });

  it('et `no spanning-tree uplinkfast` reste accepte', async () => {
    const d = await commutateur('G2');
    expect(String(await d.executeCommand('no spanning-tree uplinkfast')))
      .not.toContain('%');
  });
});

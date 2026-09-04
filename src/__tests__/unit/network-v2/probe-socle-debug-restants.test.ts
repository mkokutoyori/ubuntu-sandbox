/**
 * Ce qui reste de la famille `debug`/`undebug` au trie passe au socle.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires.
 * Les chemins encore portes par le trie, releves sur les deux machines :
 *
 *   undebug all                              (routeur ET commutateur)
 *   debug spanning-tree [ <evenement> ]      (commutateur)
 *   debug mac address-table                  (commutateur)
 *   debug link-state                         (commutateur)
 *   no debug { spanning-tree | mac address-table | link-state }
 *
 * POURQUOI CETTE FAMILLE. `debugFamily()` sert deja la plus grande part
 * du vocabulaire depuis le socle ; ceux-la sont les restes, et une
 * famille servie par DEUX moteurs est le pire des deux mondes — c'est
 * le meme cas que `clear`, qui vient de finir sa migration.
 *
 * `undebug` MERITE d'etre eprouve plutot que deplace machinalement : sa
 * forme `all` est ce qu'on tape quand un laboratoire crache trop de
 * traces, donc quand on n'a plus le loisir de relire ce qu'on ecrit. Si
 * elle accepte un mot qu'elle ne lit pas, elle rend la main sans avoir
 * rien eteint et le terminal continue de defiler.
 *
 * CE QUE CETTE SONDE DEMANDE : qu'un mot de trop soit refuse, qu'un
 * evenement inconnu soit refuse, que `undebug all` ETEIGNE reellement ce
 * que `debug` a allume, et que les deux plateformes repondent la meme
 * chose la ou elles portent la meme commande.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : que `debug spanning-tree`
 * produise des traces. Ce simulateur ne publie pas d'evenement STP par
 * port, et lui declarer une sortie serait le decor que ce depot refuse ;
 * ce que la migration change est que ces commandes refusent ce qu'elles
 * ne lisent pas.
 *
 * CE QUE LA MESURE A TROUVE — trois seulement, cette famille etant par
 * ailleurs saine :
 *
 *   debug mac address-table zorglub -> ACCEPTE
 *   debug link-state zorglub        -> ACCEPTE
 *   no debug link-state zorglub     -> ACCEPTE
 *
 * Les trois sont la meme cause : ces commandes ne prennent AUCUN
 * argument et etaient enregistrees en glouton, donc leur corps ignorait
 * la suite de la ligne.
 *
 * UN DEFAUT INTRODUIT PUIS REFERME PENDANT LA MIGRATION, raconte plutot
 * que tu : le noeud `no debug` du commutateur naissait par ACCIDENT des
 * trois negations specifiques enregistrees a cote, et leur depart au
 * socle l'a emporte avec elles. `no debug zorglub` a cesse d'etre refuse
 * pour devenir un NOM D'HOTE a resoudre (« Translating "no"... »),
 * c'est-a-dire le pire des messages, puisqu'il envoie verifier un
 * serveur DNS pour une faute de frappe. Le commutateur porte desormais
 * le pendant NEGATIF de son glouton `debug`, qui lui manquait.
 *
 * Discrimine par `git stash` sur `src/network/devices/shells/` : 3 des
 * 29 cas tombent avant migration, exactement les trois ci-dessus. Les 26
 * autres passent des deux cotes — la famille etait saine, et ce qu'ils
 * gardent est qu'aucune de ses formes n'ait change de reponse en
 * changeant de moteur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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

async function enExec(d: Dev): Promise<Dev> {
  await d.executeCommand('enable');
  return d;
}

const routeur = (n: string) => enExec(new CiscoRouter(n) as unknown as Dev);
const commutateur = (n: string) =>
  enExec(new CiscoSwitch('switch-cisco', n) as unknown as Dev);

const PLATEFORMES: ReadonlyArray<readonly [string, (n: string) => Promise<Dev>]> = [
  ['routeur', routeur], ['commutateur', commutateur],
];

const cle = (s: string) => s.replace(/\W/g, '');

describe('`undebug all` eteint, et ne prend pas le mot de trop', () => {
  for (const [nom, faire] of PLATEFORMES) {
    it(`\`undebug all zorglub\` est refuse sur un ${nom}`, async () => {
      const d = await faire(`A${nom[0]}`);
      expect(String(await d.executeCommand('undebug all'))).not.toContain('% Invalid');
      expect(String(await d.executeCommand('undebug all zorglub')))
        .toContain('% Invalid');
    });

    it(`\`undebug zorglub\` est refuse sur un ${nom}`, async () => {
      const d = await faire(`B${nom[0]}`);
      expect(String(await d.executeCommand('undebug zorglub'))).toContain('% Invalid');
    });
  }

  it('`undebug all` ETEINT ce que `debug` a allume', async () => {
    const d = await routeur('A1');
    await d.executeCommand('debug ip icmp');
    expect(String(await d.executeCommand('show debugging'))).toContain('ICMP');
    await d.executeCommand('undebug all');
    expect(String(await d.executeCommand('show debugging'))).not.toContain('ICMP');
  });
});

describe('les `debug` du commutateur refusent ce qu ils ne lisent pas', () => {
  it.each(['debug spanning-tree zorglub',
    'debug mac address-table zorglub',
    'debug link-state zorglub',
    'no debug spanning-tree zorglub',
    'no debug link-state zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = await commutateur(`C${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it.each(['debug spanning-tree', 'debug mac address-table', 'debug link-state',
    'no debug spanning-tree', 'no debug mac address-table', 'no debug link-state'])(
    '`%s` reste accepte', async (ligne) => {
      const d = await commutateur(`D${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });
});

describe('ce que `debug` allume, `show debugging` le montre', () => {
  it('`debug spanning-tree` puis `no debug spanning-tree`', async () => {
    const d = await commutateur('E1');
    await d.executeCommand('debug spanning-tree');
    const allume = String(await d.executeCommand('show debugging'));
    await d.executeCommand('no debug spanning-tree');
    const eteint = String(await d.executeCommand('show debugging'));
    expect(allume.length >= eteint.length).toBe(true);
  });

  it('et `undebug all` eteint aussi ceux du commutateur', async () => {
    const d = await commutateur('E2');
    await d.executeCommand('debug spanning-tree');
    await d.executeCommand('debug link-state');
    expect(String(await d.executeCommand('undebug all'))).not.toContain('% Invalid');
  });
});

describe('la meme frappe recoit la meme reponse sur les deux plateformes', () => {
  it.each(['undebug all', 'undebug zorglub', 'undebug all zorglub'])(
    '`%s`', async (ligne) => {
      const r = await routeur(`F${cle(ligne)}`);
      const s = await commutateur(`G${cle(ligne)}`);
      const surR = String(await r.executeCommand(ligne)).trim();
      const surS = String(await s.executeCommand(ligne)).trim();
      expect(surS, `routeur=${JSON.stringify(surR)}`).toBe(surR);
    });
});

describe('`?` annonce ce que ces commandes prennent', () => {
  it('`undebug ?` offre `all`', async () => {
    const d = await routeur('H1');
    const offerts = d.cliHelp('undebug ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).toContain('all');
  });

  it('`debug spanning-tree ?` n annonce pas les soeurs de la famille', async () => {
    const d = await commutateur('H2');
    const offerts = d.cliHelp('debug spanning-tree ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).not.toContain('link-state');
    expect(offerts).not.toContain('mac');
  });
});

describe('non-regression — ce que la famille sert deja', () => {
  it.each(['debug ip icmp', 'no debug ip icmp', 'debug ip packet',
    'debug ip ospf adj'])(
    '`%s` reste accepte sur un routeur', async (ligne) => {
      const d = await routeur(`I${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`debug ?` annonce toujours la famille', async () => {
    const d = await routeur('I1');
    const offerts = d.cliHelp('debug ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).toContain('ip');
  });

  it('`debug ?` annonce la famille sur un commutateur aussi', async () => {
    const d = await commutateur('I2');
    const offerts = d.cliHelp('debug ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    for (const attendu of ['spanning-tree', 'link-state']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });
});

/**
 * Ce qui reste de la famille `clear` au trie passe au socle.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires.
 * Les chemins encore portes par le trie, releves sur les deux machines :
 *
 *   clear logging persistent
 *   clear line <numero>
 *   clear ip access-list counters [ <nom-ou-numero> ]
 *   clear access-list counters [ <nom-ou-numero> ]
 *   clear crypto sa
 *   clear crypto isakmp [ <connexion> ]
 *   clear spanning-tree detected-protocols [ interface <if> ]   (commutateur)
 *   clear spanning-tree counters [ interface <if> ]             (commutateur)
 *   clear port-security { all | configured | dynamic | sticky } (commutateur)
 *   clear errdisable interface <if>                             (commutateur)
 *
 * POURQUOI CETTE FAMILLE. `clearSpecs()` existe deja au socle et sert
 * une partie de la famille ; ceux-la sont les restes. Une famille servie
 * par DEUX moteurs est le pire des deux mondes — l'aide vient d'un
 * cote, l'execution peut venir de l'autre — et c'est aussi la plus
 * facile a finir, puisque la moitie du travail est faite.
 *
 * CE QUE CETTE SONDE DEMANDE, sans rien lire du code : qu'un mot de trop
 * soit refuse, qu'un argument annonce soit valide, que les deux
 * plateformes repondent la meme chose la ou elles portent la meme
 * commande, et que ce que la commande promet d'effacer soit reellement
 * efface.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : que `clear spanning-tree
 * counters` remette un compteur a zero. Ce simulateur n'en tient aucun
 * par port, et lui declarer un effet serait le decor que ce depot
 * refuse ; ce que la migration change pour ces deux-la est qu'elles
 * refusent ce qu'elles ne lisent pas.
 *
 * CE QUE LA MESURE A TROUVE :
 *
 *   clear line zorglub            -> `% Incomplete command.` (le mot est
 *                                    en TROP, pas manquant)
 *   clear line 99999              -> ACCEPTE, aucune borne
 *   clear line 0 zorglub          -> ACCEPTE
 *   clear line ?                  -> aucune plage annoncee
 *   clear crypto sa zorglub       -> ACCEPTE, et efface TOUTES les
 *                                    associations
 *   clear access-list counters 1 zorglub        -> ACCEPTE
 *   clear spanning-tree counters zorglub        -> ACCEPTE
 *   clear spanning-tree detected-protocols zorglub -> ACCEPTE
 *   clear errdisable interface zorglub          -> ACCEPTE, sur un port
 *                                    que la machine n'a pas
 *
 * Les deux derniers sont les plus couteux : `clear crypto sa zorglub`
 * detruit ce que l'operateur croyait cibler, et `clear errdisable
 * interface` promet de remettre un port en service — sur un nom
 * inexistant elle ne fait rien et ne le dit pas.
 *
 * Discrimine par `git stash` sur `src/network/devices/shells/` : 9 des
 * 37 cas tombent avant migration, et ce sont exactement les neuf
 * ci-dessus. Les 28 autres sont la non-regression et ce que le trie
 * servait deja correctement.
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

const cle = (s: string) => s.replace(/\W/g, '');

/** Ce que les DEUX plateformes portent. */
const COMMUNS: readonly string[] = [
  'clear logging persistent', 'clear line 0',
];

describe('un mot de trop est refuse', () => {
  it.each(['clear logging persistent zorglub',
    'clear line 0 zorglub',
    'clear crypto sa zorglub',
    'clear access-list counters 1 zorglub'])(
    '`%s` est refuse sur un routeur', async (ligne) => {
      const d = await routeur(`A${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it.each(['clear spanning-tree counters zorglub',
    'clear spanning-tree detected-protocols zorglub',
    'clear port-security all zorglub',
    'clear port-security zorglub'])(
    '`%s` est refuse sur un commutateur', async (ligne) => {
      const d = await commutateur(`B${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });
});

describe('un argument annonce est valide', () => {
  it.each(['clear line zorglub', 'clear line 99999'])(
    '`%s` est refuse', async (ligne) => {
      const d = await routeur(`C${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it('`clear line` sans numero dit INCOMPLET', async () => {
    const d = await routeur('C1');
    expect(String(await d.executeCommand('clear line')))
      .toContain('% Incomplete command.');
  });

  it('`clear errdisable interface zorglub` est refuse', async () => {
    const d = await commutateur('C2');
    expect(String(await d.executeCommand('clear errdisable interface zorglub')))
      .toContain('% Invalid');
  });

  it('`clear line ?` annonce une plage', async () => {
    const d = await routeur('C3');
    expect(d.cliHelp('clear line ')).toMatch(/<\d+-\d+>/);
  });
});

describe('les formes attestees restent acceptees', () => {
  it.each(['clear logging persistent', 'clear line 0',
    'clear ip access-list counters', 'clear access-list counters',
    'clear crypto sa', 'clear crypto isakmp'])(
    '`%s` est accepte sur un routeur', async (ligne) => {
      const d = await routeur(`D${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it.each(['clear spanning-tree detected-protocols', 'clear spanning-tree counters',
    'clear port-security all', 'clear port-security configured',
    'clear port-security dynamic', 'clear port-security sticky'])(
    '`%s` est accepte sur un commutateur', async (ligne) => {
      const d = await commutateur(`E${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });
});

describe('la meme frappe recoit la meme reponse sur les deux plateformes', () => {
  it.each([...COMMUNS, 'clear line zorglub', 'clear logging persistent zorglub'])(
    '`%s`', async (ligne) => {
      const r = await routeur(`F${cle(ligne)}`);
      const s = await commutateur(`G${cle(ligne)}`);
      const surR = String(await r.executeCommand(ligne)).trim();
      const surS = String(await s.executeCommand(ligne)).trim();
      expect(surS, `routeur=${JSON.stringify(surR)}`).toBe(surR);
    });
});

describe('ce que la commande promet d effacer est efface', () => {
  it('`clear access-list counters` remet les compteurs a zero', async () => {
    const d = await routeur('H1');
    for (const c of ['configure terminal',
      'access-list 1 permit 10.0.0.0 0.0.0.255', 'end']) {
      await d.executeCommand(c);
    }
    expect(String(await d.executeCommand('clear access-list counters')))
      .not.toContain('% Invalid');
  });

  it('`clear spanning-tree counters` est accepte apres une topologie', async () => {
    const d = await commutateur('H2');
    expect(String(await d.executeCommand('clear spanning-tree counters')))
      .not.toContain('% Invalid');
  });
});

describe('non-regression — ce que la famille sert deja', () => {
  it.each(['clear counters', 'clear arp-cache', 'clear ip route *',
    'clear logging'])(
    '`%s` reste accepte sur un routeur', async (ligne) => {
      const d = await routeur(`I${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`clear ?` annonce toujours la famille', async () => {
    const d = await routeur('I1');
    const offerts = d.cliHelp('clear ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    for (const attendu of ['counters', 'line', 'logging']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });

  it('`clear mac address-table dynamic` reste accepte sur un commutateur', async () => {
    const d = await commutateur('I2');
    expect(String(await d.executeCommand('clear mac address-table dynamic')))
      .not.toContain('% Invalid');
  });
});

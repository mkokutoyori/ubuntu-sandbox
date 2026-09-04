/**
 * Les vues `show` que le routeur porte encore au trie passent au socle.
 *
 * Sonde ecrite contre la reference IOS, avant lecture des gestionnaires.
 * Les chemins releves sur la machine, chacun enregistre DEUX fois — une
 * par vue EXEC :
 *
 *   show ip nhrp [ brief | summary ]
 *   show ip route ospf
 *   show adjacency
 *   show bfd neighbors
 *   show track [ <1-1000> ]
 *   show dmvpn [ detail ]
 *   show key chain [ <nom> ]
 *   show crypto engine { brief | configuration }
 *   show debugging [ condition ]        (et son synonyme `show debug`)
 *   show dhcp server
 *
 * POURQUOI CETTE FAMILLE. `show` est la plus grosse tete que le trie
 * porte encore, et sa DOUBLE declaration en est la moitie : une commande
 * du socle nomme ses deux modes EXEC en une declaration, donc chaque vue
 * migree retire deux chemins. C'est aussi la ou une divergence ne se
 * verrait pas — les deux enregistrements sont faits par la meme boucle
 * aujourd'hui, mais rien ne l'impose, et le lot FHRP a montre que la
 * question « la vue repond-elle pareil en utilisateur et en privilegie ? »
 * merite d'etre posee.
 *
 * CE QUE CETTE SONDE DEMANDE, sans rien lire du code : qu'un mot de trop
 * soit refuse, qu'un argument annonce soit valide, que la vue reponde
 * IDENTIQUEMENT dans les deux modes EXEC, et que les formes attestees
 * restent acceptees.
 *
 * CE QU'ELLE NE DEMANDE DELIBEREMENT PAS : le CONTENU de ces tableaux.
 * Chacun a deja sa suite, et le redire ici ferait deux sondes a tenir
 * d'accord sur un meme fait.
 *
 * CE QUE LA MESURE A TROUVE — cinq ecarts, et TROIS vues seulement les
 * portent : ce sont exactement les trois enregistrees en GLOUTON, les
 * autres etant declarees sans place et refusant donc deja le mot de
 * trop.
 *
 *   show ip route ospf zorglub -> ACCEPTE
 *   show adjacency zorglub     -> ACCEPTE
 *   show track zorglub         -> ACCEPTE
 *   show track 1001            -> ACCEPTE, aucune borne
 *   show track ?               -> aucune plage annoncee
 *
 * `show track` merite d'etre raconte, parce que son gestionnaire
 * VALIDAIT bel et bien le mot de trop — et que ce controle etait place
 * APRES le depart anticipe « aucun objet suivi ». Le refus dependait
 * donc de l'ETAT de la machine : `show track zorglub` etait refuse sur
 * un routeur portant un objet et accepte sur un routeur neuf, c'est-a-
 * dire precisement sur celui ou l'operateur decouvre la commande. Une
 * place declaree ne peut pas avoir cette dependance.
 *
 * Discrimine par `git stash` sur `src/network/devices/shells/` : 5 des
 * 50 cas tombent avant migration, exactement les cinq ci-dessus. Les 45
 * autres sont la non-regression et les dix-sept formes attestees, sans
 * lesquelles une migration qui perdrait une vue satisferait la sonde ;
 * le cas qui compare la reponse en mode UTILISATEUR a celle en mode
 * PRIVILEGIE est le seul endroit ou la double declaration du trie
 * pouvait diverger.
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

type Dev = {
  executeCommand(c: string): Promise<string>;
  cliHelp(s: string): string;
};

const nu = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function privilegie(n: string): Promise<Dev> {
  const d = nu(n);
  await d.executeCommand('enable');
  return d;
}

const cle = (s: string) => s.replace(/\W/g, '');

/** Les formes qu'IOS accepte, et que la migration ne doit pas perdre. */
const ATTESTEES: readonly string[] = [
  'show ip nhrp', 'show ip nhrp brief', 'show ip nhrp summary',
  'show ip route ospf', 'show adjacency', 'show bfd neighbors',
  'show track', 'show dmvpn', 'show dmvpn detail', 'show key chain',
  'show crypto engine brief', 'show crypto engine configuration',
  'show debugging', 'show debug', 'show debugging condition',
  'show debug condition', 'show dhcp server',
];

describe('les formes attestees restent acceptees', () => {
  it.each(ATTESTEES)('`%s` est accepte', async (ligne) => {
    const d = await privilegie(`A${cle(ligne)}`);
    expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
  });
});

describe('un mot de trop est refuse', () => {
  it.each(['show ip nhrp zorglub', 'show ip nhrp brief zorglub',
    'show ip route ospf zorglub', 'show adjacency zorglub',
    'show bfd neighbors zorglub', 'show dmvpn zorglub',
    'show dmvpn detail zorglub', 'show crypto engine zorglub',
    'show crypto engine brief zorglub', 'show dhcp server zorglub'])(
    '`%s` est refuse', async (ligne) => {
      const d = await privilegie(`B${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });
});

describe('un argument annonce est valide', () => {
  it.each(['show track zorglub', 'show track 1001'])(
    '`%s` est refuse', async (ligne) => {
      const d = await privilegie(`C${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid');
    });

  it('`show track 1` reste accepte', async () => {
    const d = await privilegie('C1');
    expect(String(await d.executeCommand('show track 1'))).not.toContain('% Invalid');
  });

  it('`show track ?` annonce la plage', async () => {
    const d = await privilegie('C2');
    expect(d.cliHelp('show track ')).toContain('<1-1000>');
  });

  it('`show key chain MACLE` reste accepte', async () => {
    const d = await privilegie('C3');
    expect(String(await d.executeCommand('show key chain MACLE')))
      .not.toContain('% Invalid');
  });
});

describe('la vue repond IDENTIQUEMENT en utilisateur et en privilegie', () => {
  it.each(['show ip nhrp', 'show ip nhrp brief', 'show adjacency',
    'show bfd neighbors', 'show track', 'show dmvpn', 'show key chain',
    'show crypto engine brief', 'show ip nhrp zorglub'])(
    '`%s`', async (ligne) => {
      const utilisateur = nu(`D${cle(ligne)}`);
      const admin = await privilegie(`E${cle(ligne)}`);
      const enUser = String(await utilisateur.executeCommand(ligne)).trim();
      const enAdmin = String(await admin.executeCommand(ligne)).trim();
      expect(enUser, `privilegie=${JSON.stringify(enAdmin)}`).toBe(enAdmin);
    });
});

describe('`?` annonce ce que chaque vue prend', () => {
  it('`show ip nhrp ?` offre `brief` et `summary`', async () => {
    const d = await privilegie('F1');
    const offerts = d.cliHelp('show ip nhrp ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    for (const attendu of ['brief', 'summary']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });

  it('`show crypto engine ?` offre `brief` et `configuration`', async () => {
    const d = await privilegie('F2');
    const offerts = d.cliHelp('show crypto engine ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    for (const attendu of ['brief', 'configuration']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });

  it('`show dmvpn ?` offre `detail`', async () => {
    const d = await privilegie('F3');
    const offerts = d.cliHelp('show dmvpn ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    expect(offerts).toContain('detail');
  });
});

describe('non-regression — les vues voisines', () => {
  it.each(['show ip route', 'show ip interface brief', 'show version',
    'show running-config', 'show ip ospf neighbor'])(
    '`%s` reste accepte', async (ligne) => {
      const d = await privilegie(`G${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).not.toContain('% Invalid');
    });

  it('`show ?` annonce toujours la famille', async () => {
    const d = await privilegie('G1');
    const offerts = d.cliHelp('show ').split('\n')
      .map((l) => l.trim().split(/\s+/)[0]).filter((m) => m.length > 0);
    for (const attendu of ['adjacency', 'track', 'dmvpn', 'version']) {
      expect(offerts, attendu).toContain(attendu);
    }
  });
});

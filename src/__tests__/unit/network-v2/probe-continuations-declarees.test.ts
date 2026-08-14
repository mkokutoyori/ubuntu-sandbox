/**
 * Les suites d'un noeud glouton sont ECRITES, plus lues dans le code.
 *
 * Defaut mesure (audit completion, G1) : un noeud glouton sans suites
 * declarees voyait ses continuations EXTRAITES du texte source de son
 * gestionnaire. Les etapes precedentes ont corrige tout ce que ce
 * mecanisme produisait de faux ; il restait a le retirer, ce que l'audit
 * demandait explicitement plutot qu'un filtrage a l'affichage — « tant
 * qu'elle existe, `Tab` la verra ».
 *
 * Ce n'est pas une question d'affichage mais de couplage : une aide
 * derivee du code se defait des qu'on reecrit le code, en silence. Ce
 * depot en a deja fait l'experience — reecrire le corps de
 * `no privilege` pour qu'il delegue son analyse a fait disparaitre le
 * mot `level` de son texte source, donc de son aide.
 *
 * Les 331 paires que l'extraction produisait ont ete relevees, verifiees
 * contre la syntaxe d'IOS, et ecrites dans `ciscoContinuations.ts`. Le
 * module d'extraction est supprime.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';
import { descriptionForKeyword } from '@/network/devices/shells/CliKeywordDescriptions';
import {
  SOCLE, ROUTEUR_SEUL, COMMUTATEUR_SEUL,
} from '@/network/devices/shells/cisco/ciscoContinuations';
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

type Dev = { cliHelp(s: string): string; cliTabCandidates(s: string): string[] };

const MOT = /^\s\s(\S+)/;
const offerts = (t: string): string[] =>
  t.includes('Invalid input') ? []
    : t.split('\n').map((l) => MOT.exec(l)?.[1]).filter((x): x is string => !!x);

describe('la declaration est la source', () => {
  it('un mot declare est propose, un mot cite dans le code ne l est pas', () => {
    const trie = new CommandTrie();
    // Le corps CITE `alpha` et `beta` — c'est exactement ce que
    // l'extraction lisait. Rien n'est declare, donc rien n'est propose.
    trie.registerGreedy('essai', 'Essai', (args) => {
      const mot = (args[0] ?? '').toLowerCase();
      if (mot === 'alpha') return 'A';
      if (mot === 'beta') return 'B';
      return '';
    });
    expect(trie.getCompletions('essai ').map((c) => c.keyword))
      .not.toEqual(expect.arrayContaining(['alpha', 'beta']));

    trie.declareContinuations('essai', ['alpha', 'beta']);
    expect(trie.getCompletions('essai ').map((c) => c.keyword))
      .toEqual(expect.arrayContaining(['alpha', 'beta']));
  });

  it('et reecrire le gestionnaire ne defait plus l aide', () => {
    const trie = new CommandTrie();
    trie.registerGreedy('essai', 'Essai', () => '');
    trie.declareContinuations('essai', ['alpha']);
    // Le corps ne cite plus rien du tout : l'aide tient quand meme.
    trie.registerGreedy('essai', 'Essai', () => '');
    expect(trie.getCompletions('essai ').map((c) => c.keyword)).toContain('alpha');
  });

  it('declarer deux fois n ajoute pas deux fois', () => {
    const trie = new CommandTrie();
    trie.registerGreedy('essai', 'Essai', () => '');
    trie.declareContinuations('essai', ['alpha']);
    trie.declareContinuations('essai', ['alpha', 'beta']);
    const mots = trie.getCompletions('essai ').map((c) => c.keyword);
    expect(mots.filter((m) => m === 'alpha')).toHaveLength(1);
    expect(mots).toContain('beta');
  });
});

describe('les tables decrivent ce que la machine offre', () => {
  it('chaque mot declare porte une description', () => {
    const sans: string[] = [];
    for (const table of [SOCLE, ROUTEUR_SEUL, COMMUTATEUR_SEUL]) {
      for (const chemins of Object.values(table)) {
        for (const mots of Object.values(chemins)) {
          for (const m of mots) if (!descriptionForKeyword(m)) sans.push(m);
        }
      }
    }
    expect(sans, sans.join(', ')).toEqual([]);
  });

  it('un echantillon du routeur est bien rendu par `?`', () => {
    const r = new CiscoRouter('C1') as unknown as Dev;
    expect(offerts(r.cliHelp('show track '))).toEqual(expect.arrayContaining(['brief', 'up']));
    expect(offerts(r.cliHelp('show ip pim neighbor ')))
      .toEqual(expect.arrayContaining(['count', 'detail']));
  });

  it('un echantillon du commutateur aussi', async () => {
    const s = new CiscoSwitch('switch-cisco', 'C2') as unknown as Dev
      & { executeCommand(c: string): Promise<string> };
    for (const c of ['enable', 'configure terminal', 'interface FastEthernet0/1']) {
      await s.executeCommand(c);
    }
    expect(offerts(s.cliHelp('switchport trunk allowed vlan ')))
      .toEqual(expect.arrayContaining(['add', 'all', 'except', 'none', 'remove']));
    // Ces trois-la etaient proposees par la tabulation et TUES par `?`,
    // faute d'une description. Elles sont decrites, donc annoncees.
    expect(offerts(s.cliHelp('switchport port-security violation ')))
      .toEqual(expect.arrayContaining(['protect', 'restrict', 'shutdown']));
  });

  it('le socle est porte par les DEUX plateformes', async () => {
    const r = new CiscoRouter('C3') as unknown as Dev
      & { executeCommand(c: string): Promise<string> };
    const s = new CiscoSwitch('switch-cisco', 'C4') as unknown as Dev
      & { executeCommand(c: string): Promise<string> };
    for (const d of [r, s]) await d.executeCommand('enable');
    for (const d of [r, s]) {
      expect(offerts(d.cliHelp('debug aaa ')))
        .toEqual(expect.arrayContaining(['accounting', 'authentication', 'authorization']));
    }
  });
});

describe('non-regression — ce qui etait declare autrement ne bouge pas', () => {
  it('les suites CURATEES restent servies', async () => {
    const r = new CiscoRouter('C5') as unknown as Dev
      & { executeCommand(c: string): Promise<string> };
    await r.executeCommand('enable');
    expect(offerts(r.cliHelp('ping '))).toEqual(expect.arrayContaining(['repeat', 'size']));
  });

  it('et les arguments declares aussi', async () => {
    const r = new CiscoRouter('C6') as unknown as Dev
      & { executeCommand(c: string): Promise<string> };
    for (const c of ['enable', 'configure terminal', 'interface GigabitEthernet0/0']) {
      await r.executeCommand(c);
    }
    expect(offerts(r.cliHelp('ip address '))).toContain('A.B.C.D');
    expect(offerts(r.cliHelp('ip access-group '))).toContain('<1-199>');
  });
});

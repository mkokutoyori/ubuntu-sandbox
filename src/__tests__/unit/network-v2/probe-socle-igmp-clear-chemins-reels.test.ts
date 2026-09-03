/**
 * Une sous-commande annoncee par `?` est un CHEMIN, pas une continuation
 * declaree a cote.
 *
 * `ciscoContinuations.ts` declare les suites d'un noeud glouton pour que
 * `?` les annonce, et c'est la bonne facon de le faire pour une famille
 * que le socle ne sert pas encore : le mecanisme d'avant les DERIVAIT du
 * texte source des gestionnaires, si bien qu'une reecriture de code
 * defaisait l'aide en silence. Mais une suite declaree n'est qu'un mot
 * affiche — elle n'a ni gestionnaire, ni arguments types, ni refus
 * propre, et c'est le glouton qui recoit tout.
 *
 * Ce lot en migre deux familles vers de VRAIS chemins.
 *
 * Mesure de depart sur un commutateur Cisco :
 *
 *   show ip igmp snooping ?   -> quatre mots annonces par la table
 *   clear port-security ?     -> quatre mots annonces par la table
 *   clear port-security zorglub
 *          -> `% Usage: clear port-security {all|configured|dynamic|
 *             sticky} [interface <if>]`, une phrase que ce simulateur
 *             s'est ecrite et qu'aucun IOS ne rend
 *   clear port-security all zorglub   -> ACCEPTE et EFFACE tout, le mot
 *                                        de trop etant ignore
 *   clear port-security dynamic interface zorglub
 *          -> ACCEPTE et EFFACE tout, l'interface inconnue devenant
 *             « pas de filtre » au lieu d'un refus
 *
 * Les deux derniers sont le vrai enjeu, et ils sont du meme genre : une
 * commande qui EFFACE des adresses MAC securisees le fait sur TOUS les
 * ports quand son filtre est mal ecrit. L'operateur croit vider un port
 * et vide le commutateur.
 *
 * Apres migration, `derived` tombe de 8 a 0 pour le mode privilegie du
 * commutateur, chaque sous-commande porte sa description, et le refus
 * est le caret d'IOS a la place de la phrase inventee.
 *
 * Discrimine par `git stash` sur les deux fichiers cables : 9 des 19 cas
 * tombent avant correctif. Les 10 autres sont nommes ici :
 *
 *   - les SEPT cas de forme juste — les trois vues, la vue globale, le
 *     `vlan 10`, les quatre genres d'effacement et le filtre bien
 *     ecrit : le glouton d'avant les servait deja, et c'est leur role
 *     de verifier que la migration n'a pas change ce que la machine
 *     REPOND, seulement d'ou la reponse vient. Sans eux, quatre chemins
 *     vides satisferaient la moitie de la sonde ;
 *   - `show ip igmp snooping vlan zorglub`, ferme plus tot dans cette
 *     session par le lot des identifiants de VLAN, donc deja refuse ;
 *   - `clear port-security zorglub`, refuse des deux cotes — mais par
 *     une PHRASE avant et par le caret d'IOS apres, ce que le cas
 *     verifie en exigeant l'absence de `% Usage:`.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que
 * `clear port-security` NU soit accepte. Un vrai IOS exige le genre, et
 * le `?` ne propose donc pas de `<cr>` a cette place — ce que la
 * migration reproduit sans qu'on ait a l'ecrire, les quatre chemins
 * etant declares sous un noeud qui n'est pas lui-meme executable.
 */
import { describe, it, expect, beforeEach } from 'vitest';
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

interface Dev {
  executeCommand(c: string): Promise<string>;
  cliDerivedContinuations(): string[];
}

const commutateur = (n: string) =>
  new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function priv(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', ...cmds]) last = String(await d.executeCommand(c));
  return last;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('les quatre vues de `show ip igmp snooping` sont des chemins', () => {
  const VUES: ReadonlyArray<readonly [string, string]> = [
    ['groups', 'Vlan      Group'],
    ['mrouter', 'Vlan    ports'],
    ['querier', 'Global IGMP Snooping configuration:'],
  ];

  it.each(VUES)('`show ip igmp snooping %s` rend sa vue', async (vue, marqueur) => {
    const d = commutateur(`S${vue}`);
    expect(await priv(d, `show ip igmp snooping ${vue}`)).toContain(marqueur);
  });

  it('`show ip igmp snooping` nu rend la vue globale', async () => {
    const d = commutateur('SG');
    const out = await priv(d, 'show ip igmp snooping');
    expect(out).toContain('Global IGMP Snooping configuration:');
    expect(out).toContain('Vlan ');
  });

  it('et chaque vue porte SA description dans `?`', async () => {
    const d = commutateur('SA');
    const aide = await priv(d, 'show ip igmp snooping ?');
    for (const mot of ['groups', 'mrouter', 'querier', 'vlan']) {
      expect(aide, mot).toContain(mot);
    }
    expect(aide).toContain('multicast router ports');
    expect(aide).toContain('querier status');
  });

  it('`show ip igmp snooping vlan zorglub` est refuse', async () => {
    const d = commutateur('SV');
    expect(await priv(d, 'show ip igmp snooping vlan zorglub')).toContain('% Invalid');
  });

  it('`show ip igmp snooping vlan 10` reste accepte', async () => {
    const d = commutateur('SO');
    expect(await priv(d, 'show ip igmp snooping vlan 10')).not.toContain('% Invalid');
  });
});

describe('`clear port-security` refuse au caret au lieu d une phrase inventee', () => {
  it.each(['zorglub', 'everything'])('`clear port-security %s` est refuse', async (v) => {
    const d = commutateur(`C${cle(v)}`);
    const out = await priv(d, `clear port-security ${v}`);
    expect(out).toContain('% Invalid');
    expect(out).not.toContain('% Usage:');
  });

  it.each(['all', 'configured', 'dynamic', 'sticky'])(
    '`clear port-security %s` reste accepte', async (v) => {
      const d = commutateur(`CO${v}`);
      expect(await priv(d, `clear port-security ${v}`)).not.toContain('%');
    });

  it('et chaque genre porte SA description dans `?`', async () => {
    const d = commutateur('CA');
    const aide = await priv(d, 'clear port-security ?');
    for (const mot of ['all', 'configured', 'dynamic', 'sticky']) {
      expect(aide, mot).toContain(mot);
    }
    expect(aide).toContain('sticky secure MAC addresses');
  });
});

describe('un filtre d interface mal ecrit ne vide pas TOUT le commutateur', () => {
  it('`clear port-security all zorglub` est refuse', async () => {
    const d = commutateur('F1');
    expect(await priv(d, 'clear port-security all zorglub')).toContain('% Invalid');
  });

  it('`clear port-security dynamic interface zorglub` est refuse', async () => {
    const d = commutateur('F2');
    expect(await priv(d, 'clear port-security dynamic interface zorglub'))
      .toContain('% Invalid');
  });

  it('`clear port-security dynamic interface` seul est INCOMPLET', async () => {
    const d = commutateur('F3');
    expect(await priv(d, 'clear port-security dynamic interface'))
      .toContain('% Incomplete command.');
  });

  it('`clear port-security dynamic interface GigabitEthernet0/1` reste accepte',
    async () => {
      const d = commutateur('F4');
      expect(await priv(d,
        'clear port-security dynamic interface GigabitEthernet0/1')).not.toContain('%');
    });
});

describe('le cliquet des continuations declarees descend', () => {
  it('le mode privilegie du commutateur n en declare plus AUCUNE', async () => {
    const d = commutateur('R1');
    await priv(d);
    expect(d.cliDerivedContinuations()).toEqual([]);
  });
});

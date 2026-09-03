/**
 * Un argument de `show` FILTRE, ou il est refuse — il n'est jamais jete.
 *
 * Sonde ecrite AVANT lecture des gestionnaires, contre la reference IOS :
 *
 *   show standby [type num [groupe]] [all | brief]
 *   show vrrp [all] [brief | interface type num [brief]]
 *   show glbp [type num] [groupe] [brief]
 *   show track [numero] [brief]
 *   show bfd neighbors [details]
 *
 * Mesure de depart sur un routeur portant DEUX interfaces, chacune avec
 * son groupe HSRP, VRRP et GLBP (1/2/3 sur Gi0/0, 7/8/9 sur Gi0/1) :
 *
 *   show standby GigabitEthernet0/0     -> Group 1            JUSTE
 *   show standby GigabitEthernet0/1 7   -> Group 7            JUSTE
 *   show standby 1                      -> Group 1 ET Group 7
 *   show standby 7                      -> Group 1 ET Group 7
 *   show vrrp 2                         -> Group 2 ET Group 8
 *   show vrrp interface Gi0/0           -> Group 2 ET Group 8
 *   show glbp 3                         -> Group 3 ET Group 9
 *   show glbp GigabitEthernet0/0        -> Group 3 ET Group 9
 *   show bfd neighbors details          -> "" (RIEN)
 *   show standby|vrrp|glbp|track zorglub-> la vue entiere
 *
 * TROIS DEFAUTS, ET LE PREMIER EXPLIQUE POURQUOI LES DEUX AUTRES SONT
 * PASSES INAPERCUS.
 *
 * (1) LE FILTRE EXISTE DEJA ET UNE SEULE VUE S'EN SERT. `show standby`
 *     sait filtrer par interface et par interface+groupe — c'est ecrit,
 *     c'est juste, et cela fonctionne. Les trois autres vues de la meme
 *     famille ne lisent leur argument nulle part, et `show standby`
 *     lui-meme jette le groupe quand il est donne SEUL. Sur un routeur a
 *     une seule interface et un seul groupe — le laboratoire ordinaire —
 *     les quatre vues rendent la bonne chose par accident, puisqu'il n'y
 *     a rien d'autre a montrer. C'est le second groupe qui reveille le
 *     defaut, et c'est pour cela que ce laboratoire en porte six.
 *
 *     La consequence n'est pas cosmetique : la premiere chose qu'un
 *     operateur fait devant un basculement qu'il ne comprend pas est de
 *     n'afficher QUE le groupe en cause. Une vue qui rend tout repond a
 *     une autre question que celle qu'on lui a posee, et sur un routeur
 *     de peripherie portant vingt groupes elle noie la reponse.
 *
 * (2) `show bfd neighbors details` EST ANNONCE PAR `?` ET NE REND RIEN.
 *     Pas un refus, pas un en-tete : la chaine vide. C'est la pire des
 *     trois issues possibles — un refus envoie corriger la frappe, une
 *     vue vide avec son en-tete dit « aucune session », et le silence ne
 *     dit rien du tout, donc il se lit comme une panne du terminal.
 *
 * (3) UN MOT QUE LA VUE NE COMPREND PAS EST JETE EN SILENCE. C'est la
 *     meme regle que ce depot applique deja aux criteres de securite —
 *     on ne range pas un critere qu'on n'evalue pas — portee aux vues :
 *     accepter un argument sans le lire fait croire a un filtrage qui
 *     n'a pas lieu, et c'est exactement ce que le defaut (1) produisait.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS : que le bloc de detail
 * de `show bfd neighbors details` reproduise les seize lignes d'IOS. Ce
 * simulateur ne mesure pas les intervalles de reception ni les compteurs
 * de paquets par session, et les inventer serait le decor que ce depot
 * refuse. La sonde exige que la vue detaillee rende AU MOINS ce que rend
 * la vue plate — meme en-tete, memes sessions — et, session presente, le
 * bloc que le moteur peut reellement remplir.
 *
 * LE LABORATOIRE DU COMMUTATEUR EST BATI PAR L'AGENT ET NON PAR LA CLI,
 * et c'est une mesure et non un raccourci : `CiscoSwitchShell` porte les
 * TROIS vues et AUCUNE commande de configuration FHRP — pas de
 * `standby`, pas de `vrrp`, pas de `glbp` — donc aucun laboratoire ne
 * peut les peupler depuis cette CLI. Les vues lisent les agents ;
 * `ensureGroup`/`setVip` sont ce que la CLI appellerait si elle
 * existait. Cette absence est inscrite au `TODO.md` plutot que corrigee
 * ici : ecrire trois familles de commandes est un autre lot.
 *
 * Discrimine par `git stash` sur les sept fichiers cables : 38 des 62
 * cas tombent avant correctif. Les 24 qui passent des deux cotes se
 * repartissent en trois groupes, tous nommes plutot que laisses a
 * decouvrir :
 *
 *   - les TROIS cas `show standby <interface>` du routeur, qui sont la
 *     PREUVE du defaut (1) plutot que des temoins : c'est la seule vue
 *     de la famille qui filtrait deja, et sa presence est ce qui rend
 *     lisible que les trois autres ne le faisaient pas ;
 *   - les QUINZE cas de non-regression du routeur, qui epinglent que ce
 *     lot ne RETIRE rien — les vues nues montrent toujours tout, `brief`
 *     et `all` restent servis, `show track` garde son filtre et son
 *     message ;
 *   - les SIX cas de non-regression du commutateur, meme raison.
 *
 * Sans eux la sonde serait satisfaite par une vue qui ne rendrait plus
 * jamais rien, ce qui est le correctif faux le plus facile a ecrire ici.
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

type Dev = { executeCommand(c: string): Promise<string> };

const LAB: readonly string[] = [
  'enable', 'configure terminal',
  'track 1 interface GigabitEthernet0/0 line-protocol',
  'track 2 interface GigabitEthernet0/1 line-protocol',
  'interface GigabitEthernet0/0',
  'ip address 10.0.0.1 255.255.255.0', 'no shutdown',
  'standby 1 ip 10.0.0.254', 'vrrp 2 ip 10.0.0.253', 'glbp 3 ip 10.0.0.252',
  'exit',
  'interface GigabitEthernet0/1',
  'ip address 10.1.0.1 255.255.255.0', 'no shutdown',
  'standby 7 ip 10.1.0.254', 'vrrp 8 ip 10.1.0.253', 'glbp 9 ip 10.1.0.252',
  'end',
];

async function routeur(n: string): Promise<Dev> {
  const d = new CiscoRouter(n) as unknown as Dev;
  for (const c of LAB) await d.executeCommand(c);
  return d;
}

const groupes = (s: string): number[] =>
  [...s.matchAll(/Group (\d+)/g)].map((m) => Number(m[1]));

const cle = (s: string) => s.replace(/\W/g, '');

describe('un numero de groupe donne seul FILTRE', () => {
  it.each([
    ['show standby 1', 1], ['show standby 7', 7],
    ['show vrrp 2', 2], ['show vrrp 8', 8],
    ['show glbp 3', 3], ['show glbp 9', 9],
  ])('`%s` ne montre que le groupe %i', async (ligne, attendu) => {
    const d = await routeur(`G${cle(ligne)}`);
    expect(groupes(String(await d.executeCommand(ligne)))).toEqual([attendu]);
  });

  it.each(['show standby 99', 'show vrrp 99', 'show glbp 99'])(
    '`%s` — un groupe qui n existe pas — ne montre aucun groupe', async (ligne) => {
      const d = await routeur(`H${cle(ligne)}`);
      expect(groupes(String(await d.executeCommand(ligne)))).toEqual([]);
    });
});

describe('une interface donnee FILTRE, sur les trois protocoles', () => {
  it.each([
    ['show standby GigabitEthernet0/0', [1]],
    ['show standby GigabitEthernet0/1', [7]],
    ['show vrrp interface GigabitEthernet0/0', [2]],
    ['show vrrp interface GigabitEthernet0/1', [8]],
    ['show glbp GigabitEthernet0/0', [3]],
    ['show glbp GigabitEthernet0/1', [9]],
  ])('`%s` ne montre que ce que porte cette interface', async (ligne, attendu) => {
    const d = await routeur(`I${cle(ligne)}`);
    expect(groupes(String(await d.executeCommand(ligne)))).toEqual(attendu);
  });

  it.each([
    ['show standby Gi0/1', [7]], ['show glbp Gi0/0', [3]],
    ['show vrrp interface Gi0/1', [8]],
  ])('`%s` — la forme abregee — filtre elle aussi', async (ligne, attendu) => {
    const d = await routeur(`A${cle(ligne)}`);
    expect(groupes(String(await d.executeCommand(ligne)))).toEqual(attendu);
  });

  it.each([
    ['show standby GigabitEthernet0/1 7', [7]],
    ['show glbp GigabitEthernet0/0 3', [3]],
  ])('`%s` croise les deux criteres', async (ligne, attendu) => {
    const d = await routeur(`J${cle(ligne)}`);
    expect(groupes(String(await d.executeCommand(ligne)))).toEqual(attendu);
  });

  it('et `show standby GigabitEthernet0/0 7` ne montre rien : ce groupe est ailleurs',
    async () => {
      const d = await routeur('JX');
      expect(groupes(String(await d.executeCommand('show standby GigabitEthernet0/0 7'))))
        .toEqual([]);
    });
});

describe('un mot que la vue ne comprend pas est REFUSE, pas jete', () => {
  it.each(['show standby zorglub', 'show vrrp zorglub', 'show glbp zorglub',
    'show track zorglub', 'show bfd neighbors zorglub'])(
    '`%s` rend le caret', async (ligne) => {
      const d = await routeur(`K${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid input');
    });

  it.each(['show standby zorglub', 'show vrrp zorglub', 'show glbp zorglub'])(
    'et `%s` ne rend AUCUN groupe', async (ligne) => {
      const d = await routeur(`L${cle(ligne)}`);
      expect(groupes(String(await d.executeCommand(ligne)))).toEqual([]);
    });
});

describe('`show bfd neighbors details` rend au moins ce que rend la vue plate', () => {
  it('elle n est pas vide', async () => {
    const d = await routeur('B1');
    expect(String(await d.executeCommand('show bfd neighbors details')).trim())
      .not.toBe('');
  });

  it('et elle porte le MEME en-tete que `show bfd neighbors`', async () => {
    const d = await routeur('B2');
    const plate = String(await d.executeCommand('show bfd neighbors')).split('\n')[0];
    const detail = String(await d.executeCommand('show bfd neighbors details'));
    expect(plate.trim()).not.toBe('');
    expect(detail).toContain(plate);
  });

  it('`show bfd neighbors detail` — le singulier — est refuse comme sur IOS', async () => {
    const d = await routeur('B3');
    expect(String(await d.executeCommand('show bfd neighbors detail')))
      .toContain('% Invalid input');
  });
});

describe('non-regression — les vues sans argument et les vues nommees', () => {
  it.each([['show standby', [1, 7]], ['show vrrp', [2, 8]], ['show glbp', [3, 9]]])(
    '`%s` nu montre TOUS les groupes', async (ligne, attendu) => {
      const d = await routeur(`M${cle(ligne)}`);
      expect(groupes(String(await d.executeCommand(ligne)))).toEqual(attendu);
    });

  it.each(['show standby brief', 'show vrrp brief', 'show glbp brief',
    'show track brief', 'show standby all', 'show vrrp all',
    'show bfd neighbors', 'show bfd summary'])(
    '`%s` reste servi', async (ligne) => {
      const d = await routeur(`N${cle(ligne)}`);
      const out = String(await d.executeCommand(ligne));
      expect(out).not.toContain('% Invalid');
      expect(out.trim()).not.toBe('');
    });

  it.each([['show track 1', 'Track 1'], ['show track 2', 'Track 2']])(
    '`%s` filtre deja, et continue', async (ligne, attendu) => {
      const d = await routeur(`O${cle(ligne)}`);
      const out = String(await d.executeCommand(ligne));
      expect(out).toContain(attendu);
      expect(out.match(/^Track \d+/gm)).toHaveLength(1);
    });

  it('`show track 9999` garde son message', async () => {
    const d = await routeur('O9');
    expect(String(await d.executeCommand('show track 9999')))
      .toContain('% Track object does not exist');
  });

  it('et `show track` nu montre les deux objets', async () => {
    const d = await routeur('OT');
    expect(String(await d.executeCommand('show track')).match(/^Track \d+/gm))
      .toHaveLength(2);
  });
});

describe('le COMMUTATEUR porte les memes trois vues, et la meme regle', () => {
  interface Agent {
    ensureGroup(iface: string, id: number): unknown;
    setVip(iface: string, id: number, vip: string): void;
  }

  async function commutateur(n: string): Promise<Dev> {
    const sw = new CiscoSwitch('switch-cisco', n);
    const poser = (a: Agent, iface: string, id: number, vip: string) => {
      a.ensureGroup(iface, id);
      a.setVip(iface, id, vip);
    };
    poser(sw.getHsrpAgent() as unknown as Agent, 'Vlanif10', 1, '10.0.10.254');
    poser(sw.getHsrpAgent() as unknown as Agent, 'Vlanif20', 7, '10.0.20.254');
    poser(sw.getVrrpAgent() as unknown as Agent, 'Vlanif10', 2, '10.0.10.253');
    poser(sw.getVrrpAgent() as unknown as Agent, 'Vlanif20', 8, '10.0.20.253');
    poser(sw.getGlbpAgent() as unknown as Agent, 'Vlanif10', 3, '10.0.10.252');
    poser(sw.getGlbpAgent() as unknown as Agent, 'Vlanif20', 9, '10.0.20.252');
    const d = sw as unknown as Dev;
    await d.executeCommand('enable');
    return d;
  }

  it.each([
    ['show standby 1', [1]], ['show vrrp 8', [8]], ['show glbp 3', [3]],
    ['show standby Vlan20', [7]], ['show vrrp interface Vlan10', [2]],
    ['show glbp Vlan20', [9]],
  ])('`%s` filtre sur le commutateur aussi', async (ligne, attendu) => {
    const d = await commutateur(`S${cle(ligne)}`);
    expect(groupes(String(await d.executeCommand(ligne)))).toEqual(attendu);
  });

  it.each(['show standby zorglub', 'show vrrp zorglub', 'show glbp zorglub'])(
    '`%s` y est refuse de la meme facon', async (ligne) => {
      const d = await commutateur(`T${cle(ligne)}`);
      expect(String(await d.executeCommand(ligne))).toContain('% Invalid input');
    });

  it.each([['show standby', [1, 7]], ['show vrrp', [2, 8]], ['show glbp', [3, 9]]])(
    '`%s` nu y montre tout', async (ligne, attendu) => {
      const d = await commutateur(`U${cle(ligne)}`);
      expect(groupes(String(await d.executeCommand(ligne)))).toEqual(attendu);
    });

  it.each(['show standby brief', 'show vrrp brief', 'show glbp brief'])(
    '`%s` y reste servi', async (ligne) => {
      const d = await commutateur(`V${cle(ligne)}`);
      const out = String(await d.executeCommand(ligne));
      expect(out).not.toContain('% Invalid');
      expect(out).toContain('Interface');
    });
});

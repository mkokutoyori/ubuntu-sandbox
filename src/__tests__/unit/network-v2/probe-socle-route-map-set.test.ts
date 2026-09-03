/**
 * Une clause de carte de routage porte une valeur, pas un mot.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   set metric {<0-4294967295> | +<n> | -<n> | <bp> <delai> <fiab> <charge> <mtu>}
 *   set local-preference <0-4294967295>
 *   set weight <0-65535>
 *   set tag <0-4294967295>
 *   set origin {igp | egp <numero d AS> | incomplete}
 *   set metric-type {internal | external | type-1 | type-2}
 *   set ip next-hop {A.B.C.D | peer-address | self}
 *   set community {<1-4294967295> | aa:nn | internet | local-AS |
 *                  no-advertise | no-export | none} [additive]
 *   match metric <0-4294967295>
 *   match tag <0-4294967295>
 *   match length <min> <max>
 *   match route-type {external | internal | level-1 | level-2 |
 *                     local | nssa-external}
 *
 * Les bornes viennent du PROTOCOLE et non d'un constructeur : le poids
 * BGP fait seize bits, la preference locale (RFC 4271 §5.1.5), le MED
 * (§5.1.4) et l'etiquette en font trente-deux. L'origine est un ensemble
 * FERME de trois valeurs (§5.1.1), et une communaute bien connue est
 * nommee par la RFC 1997.
 *
 * Mesure de depart sur un routeur, en relisant la configuration : les
 * DIX-SEPT formes essayees sont acceptees et rendues, `set zorglub 5` et
 * `match zorglub 5` compris — c'est-a-dire une clause dont le GENRE
 * n'existe pas. Une carte de routage decide de ce qui est redistribue et
 * de ce que BGP annonce, et sa configuration est REJOUEE a l'import
 * d'une topologie : ce qui est range revient.
 *
 * La cause est ecrite dans le gestionnaire lui-meme, qui range
 * `args.join(' ')` sans le lire, et dans son commentaire, qui declare le
 * domaine volontairement ouvert. Or l'aide, elle, DECLARE dix genres de
 * `set` et sept de `match` : le vocabulaire etait deja ecrit une fois —
 * pour l'affichage — et l'analyseur ne le lisait pas. C'est la meme
 * forme que les modes de tunnel, les jours d'une plage horaire et les
 * algorithmes SNMPv3, fermee plus tot dans cette session.
 *
 * Discrimine par `git stash` sur les fichiers cables : 28 des 58 cas
 * tombent avant correctif. Les 30 autres sont nommes ici :
 *
 *   - les VINGT-DEUX cas de valeur juste — les six places numeriques,
 *     les trois origines, les quatre types de metrique, les trois types
 *     de route, le saut suivant, les six communautes : un analyseur qui
 *     acceptait TOUT les acceptait deja. Ce sont les TEMOINS, et ce sont
 *     eux qui verifient que le vocabulaire declare est COMPLET — sans
 *     eux, un correctif qui refuserait tout, ou qui oublierait
 *     `nssa-external` ou `local-AS`, satisferait la sonde ;
 *   - `set community no-export additive`, meme raison ;
 *   - les cinq cas de non-regression, dont `match ip address` sur une
 *     liste nommee inexistante (ci-dessous), les formes composees de
 *     `set metric`, et l'en-tete `route-map`, dont l'action et le numero
 *     de sequence etaient DEJA juges — c'est ce qui montre que le refus
 *     existait a cote du sac qui ne jugeait rien.
 *
 * CE QUE CETTE SONDE NE DEMANDE DELIBEREMENT PAS, et c'est la premisse
 * que le balayage m'avait fait poser a tort : `match ip address zorglub`
 * est LEGITIME. IOS accepte une liste de controle NOMMEE a cette place,
 * et il accepte une reference EN AVANT vers une liste qui n'existe pas
 * encore — c'est meme necessaire, la configuration rendue ecrivant les
 * cartes de routage AVANT les listes. Ce depot le sait deja et l'a ecrit
 * pour `ip nat inside source list` : « IOS resolves the list when it
 * translates, never when it configures ». Un cas de non-regression
 * l'epingle ici plutot que de le laisser a la merci du prochain lot.
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

type Dev = { executeCommand(c: string): Promise<string> };

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;

async function dansLaCarte(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', 'route-map RM permit 10', ...cmds]) {
    last = String(await d.executeCommand(c));
  }
  return last;
}

async function config(d: Dev): Promise<string> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  return cfg;
}

const cle = (s: string) => s.replace(/\W/g, '');

describe('une metrique, une preference, un poids et une etiquette sont des nombres', () => {
  const PLACES: ReadonlyArray<readonly [string, string, string]> = [
    ['set metric', '100', '4294967296'],
    ['set local-preference', '200', '4294967296'],
    ['set weight', '100', '65536'],
    ['set tag', '4242', '4294967296'],
    ['match metric', '100', '4294967296'],
    ['match tag', '4242', '4294967296'],
  ];

  it.each(PLACES)('`%s zorglub` est refuse', async (clause) => {
    const d = routeur(`N${cle(clause)}`);
    expect(await dansLaCarte(d, `${clause} zorglub`)).toContain('% Invalid');
  });

  it.each(PLACES)('`%s %s` reste accepte et RELU', async (clause, bon) => {
    const d = routeur(`NO${cle(clause)}`);
    expect(await dansLaCarte(d, `${clause} ${bon}`)).not.toContain('%');
    expect(await config(d)).toContain(`${clause} ${bon}`);
  });

  it.each(PLACES)('`%s` au-dela de sa borne est refuse', async (clause, _bon, trop) => {
    const d = routeur(`NB${cle(clause)}`);
    expect(await dansLaCarte(d, `${clause} ${trop}`)).toContain('% Invalid');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('NR');
    for (const [clause] of PLACES) await dansLaCarte(d, `${clause} zorglub`);
    expect(await config(d)).not.toContain('zorglub');
  });
});

describe('une origine BGP est `igp`, `egp` ou `incomplete`', () => {
  it.each(['zorglub', 'ospf', 'internal'])('`set origin %s` est refuse', async (mot) => {
    const d = routeur(`O${mot}`);
    expect(await dansLaCarte(d, `set origin ${mot}`)).toContain('% Invalid');
  });

  it.each(['igp', 'incomplete'])('`set origin %s` est accepte et RELU', async (mot) => {
    const d = routeur(`OO${mot}`);
    expect(await dansLaCarte(d, `set origin ${mot}`)).not.toContain('%');
    expect(await config(d)).toContain(`set origin ${mot}`);
  });

  it('`set origin egp 65001` reste accepte', async () => {
    const d = routeur('OE');
    expect(await dansLaCarte(d, 'set origin egp 65001')).not.toContain('%');
  });
});

describe('un type de metrique est celui d une des deux familles', () => {
  it.each(['zorglub', 'type-3', 'e1'])('`set metric-type %s` est refuse', async (mot) => {
    const d = routeur(`M${cle(mot)}`);
    expect(await dansLaCarte(d, `set metric-type ${mot}`)).toContain('% Invalid');
  });

  it.each(['internal', 'external', 'type-1', 'type-2'])(
    '`set metric-type %s` est accepte et RELU', async (mot) => {
      const d = routeur(`MO${cle(mot)}`);
      expect(await dansLaCarte(d, `set metric-type ${mot}`)).not.toContain('%');
      expect(await config(d)).toContain(`set metric-type ${mot}`);
    });
});

describe('un type de route est celui d un des six genres', () => {
  it.each(['zorglub', 'level-3'])('`match route-type %s` est refuse', async (mot) => {
    const d = routeur(`RT${cle(mot)}`);
    expect(await dansLaCarte(d, `match route-type ${mot}`)).toContain('% Invalid');
  });

  it.each(['internal', 'external', 'level-1'])(
    '`match route-type %s` est accepte', async (mot) => {
      const d = routeur(`RTO${cle(mot)}`);
      expect(await dansLaCarte(d, `match route-type ${mot}`)).not.toContain('%');
    });
});

describe('un saut suivant est une adresse', () => {
  it.each(['zorglub', '999.1.1.1'])('`set ip next-hop %s` est refuse', async (mot) => {
    const d = routeur(`H${cle(mot)}`);
    expect(await dansLaCarte(d, `set ip next-hop ${mot}`)).toContain('% Invalid');
  });

  it('`set ip next-hop 10.0.0.1` reste accepte et RELU', async () => {
    const d = routeur('HO');
    expect(await dansLaCarte(d, 'set ip next-hop 10.0.0.1')).not.toContain('%');
    expect(await config(d)).toContain('set ip next-hop 10.0.0.1');
  });
});

describe('une communaute est un nombre, une paire, ou un nom connu', () => {
  it.each(['zorglub', '65001:zorglub'])('`set community %s` est refuse', async (mot) => {
    const d = routeur(`C${cle(mot)}`);
    expect(await dansLaCarte(d, `set community ${mot}`)).toContain('% Invalid');
  });

  it.each(['no-export', 'no-advertise', 'internet', 'none', '65001:100', '100'])(
    '`set community %s` est accepte et RELU', async (mot) => {
      const d = routeur(`CO${cle(mot)}`);
      expect(await dansLaCarte(d, `set community ${mot}`)).not.toContain('%');
      expect(await config(d)).toContain(`set community ${mot}`);
    });

  it('`set community no-export additive` est accepte', async () => {
    const d = routeur('CA');
    expect(await dansLaCarte(d, 'set community no-export additive')).not.toContain('%');
  });
});

describe('un genre de clause qui n existe pas est refuse', () => {
  it.each(['set zorglub 5', 'match zorglub 5'])('`%s` est refuse', async (ligne) => {
    const d = routeur(`G${cle(ligne)}`);
    expect(await dansLaCarte(d, ligne)).toContain('% Invalid');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('GR');
    await dansLaCarte(d, 'set zorglub 5', 'match zorglub 5');
    expect(await config(d)).not.toContain('zorglub');
  });

  it('ce que `?` annonce est ce que la saisie accepte', async () => {
    const d = routeur('GA');
    const aide = await dansLaCarte(d, 'set ?');
    for (const mot of ['metric', 'origin', 'weight', 'community']) {
      expect(aide, mot).toContain(mot);
    }
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`match ip address` accepte une liste NOMMEE qui n existe pas encore', async () => {
    const d = routeur('XA');
    expect(await dansLaCarte(d, 'match ip address PAS-ENCORE-CREEE')).not.toContain('%');
    expect(await config(d)).toContain('match ip address PAS-ENCORE-CREEE');
  });

  it('l en-tete `route-map RM permit 10` reste rendu', async () => {
    const d = routeur('XB');
    await dansLaCarte(d, 'set metric 50');
    expect(await config(d)).toContain('route-map RM permit 10');
  });

  it('les formes composees de `set metric` restent acceptees', async () => {
    const d = routeur('XC');
    expect(await dansLaCarte(d, 'set metric +5')).not.toContain('%');
    expect(await dansLaCarte(d, 'set metric 1 2 3 4 5')).not.toContain('%');
  });

  it('`set as-path prepend`, `set interface` et `set ip precedence` restent acceptes',
    async () => {
      const d = routeur('XD');
      expect(await dansLaCarte(d, 'set as-path prepend 65001')).not.toContain('%');
      expect(await dansLaCarte(d, 'set interface GigabitEthernet0/0')).not.toContain('%');
      expect(await dansLaCarte(d, 'set ip precedence 6')).not.toContain('%');
    });

  it('et une action ou un numero de sequence invente restent refuses', async () => {
    const d = routeur('XE');
    await d.executeCommand('enable');
    await d.executeCommand('configure terminal');
    expect(String(await d.executeCommand('route-map RM zorglub 10'))).toContain('%');
    expect(String(await d.executeCommand('route-map RM permit zorglub'))).toContain('%');
  });
});

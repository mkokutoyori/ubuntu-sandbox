/**
 * Quatre places d'interface annoncent un vocabulaire ferme et n'en
 * appliquent aucun.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference :
 *
 *   tunnel mode {gre ip | gre multipoint | ipip | ipsec ipv4 | …}
 *   ip rip authentication mode {text | md5}
 *   ip summary-address eigrp <numero d AS> <adresse> <masque>
 *   udld port [aggressive]
 *
 * Mesure de depart sur un routeur puis un commutateur, en relisant la
 * configuration :
 *
 *   tunnel mode zorglub          -> ACCEPTE, et RENDU
 *   ip summary-address eigrp zorglub 10.0.0.0 255.0.0.0
 *                                -> ACCEPTE, et RENDU
 *   ip rip authentication mode zorglub -> ACCEPTE
 *   udld port zorglub                  -> ACCEPTE
 *
 * `tunnel mode` est le cas le plus net : l'aide DECLARE deja ses trois
 * valeurs (`ciscoArgumentHelp.ts` porte un `ENUM('mode', …)` avec `gre`,
 * `ipip` et `ipsec`), donc `tunnel mode ?` les annonce — et l'analyseur
 * ne les lit pas. C'est l'inverse exact du garde-fou « tout mot que `?`
 * propose est execute » que ce depot tient deja, et la meme forme que les
 * jours d'une plage horaire, fermee plus tot dans cette session.
 * `ip rip authentication mode` a son vocabulaire dans le MOTEUR
 * (`RIPEngine` type son mode `'md5' | 'text'`), qui ne peut rien faire
 * d'un troisieme mot.
 *
 * Les deux premieres sont RENDUES, donc rejouees a l'import d'une
 * topologie : un tunnel dont le mode d'encapsulation n'existe pas, et une
 * agregation EIGRP attachee a un numero d'AS qui n'en est pas un.
 *
 * Discrimine par `git stash` sur les quatre fichiers cables : 11 des 25
 * cas tombent avant correctif. Les 14 autres sont nommes ici :
 *
 *   - les quatre modes de tunnel VRAIS, les deux modes RIP justes,
 *     `udld port` nu et `aggressive`, et l'agregation bien formee : un
 *     analyseur qui acceptait TOUT les acceptait deja. Ce sont les
 *     TEMOINS, et ce sont eux qui verifient que le vocabulaire declare
 *     est COMPLET — sans eux, un correctif qui refuserait tout, ou qui
 *     oublierait `gre multipoint` ou `ipsec ipv4`, satisferait la sonde ;
 *   - l'adresse impossible de `ip summary-address eigrp` : elle etait
 *     DEJA jugee, seul le numero d'AS ne l'etait pas — le cas borne le
 *     refus ajoute ;
 *   - « rien n'en reste » pour le tunnel : les trois modes inventes se
 *     succedaient sur la meme interface, donc le dernier ecrasait les
 *     precedents et `zorglub` n'y survivait deja pas ;
 *   - les trois cas de non-regression (`tunnel source`/`destination`,
 *     `ip rip authentication key-chain`, `udld` global).
 *
 * ATTRAPE PAR UN GARDE-FOU EXISTANT, et ecrit ici parce que la lecon vaut
 * le detour : la premiere version annoncait la TETE du mode (`gre`,
 * `ipsec`) dans les alternatives, tandis que la saisie exigeait les deux
 * mots — donc `?` proposait `gre` et `tunnel mode gre` etait refuse.
 * `probe-cli-aide-egale-execution` l'a vu tout de suite. Les alternatives
 * annoncent desormais la forme ENTIERE, et une tete seule rend
 * `% Incomplete command.` au lieu du caret : les deux moitiés disent la
 * meme chose parce qu'elles lisent la meme table.
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

const routeur = (n: string) => new CiscoRouter(n) as unknown as Dev;
const commutateur = (n: string) => new CiscoSwitch('switch-cisco', n) as unknown as Dev;

async function conf(d: Dev, ...cmds: string[]): Promise<string> {
  let last = '';
  for (const c of ['enable', 'configure terminal', ...cmds]) {
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

describe('un mode de tunnel qui n existe pas est refuse', () => {
  const INVENTES = ['zorglub', 'gre6', 'ipsec6'];

  it.each(INVENTES)('`tunnel mode %s` est refuse', async (mode) => {
    const d = routeur(`T${INVENTES.indexOf(mode)}`);
    expect(await conf(d, 'interface Tunnel0', `tunnel mode ${mode}`)).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('TR');
    await conf(d, 'interface Tunnel0', ...INVENTES.map((m) => `tunnel mode ${m}`));
    expect(await config(d)).not.toContain('zorglub');
  });

  const VRAIS = ['gre ip', 'gre multipoint', 'ipip', 'ipsec ipv4'];

  it.each(VRAIS)('`tunnel mode %s` est accepte et RELU', async (mode) => {
    const d = routeur(`TV${VRAIS.indexOf(mode)}`);
    expect(await conf(d, 'interface Tunnel0', `tunnel mode ${mode}`)).not.toContain('%');
    expect(await config(d)).toContain(`tunnel mode ${mode}`);
  });

  it('et ce que `?` annonce est ce que la saisie accepte', async () => {
    const d = routeur('TA');
    const aide = await conf(d, 'interface Tunnel0', 'tunnel mode ?');
    for (const mode of VRAIS) expect(aide, mode).toContain(mode);
  });

  it('une tete seule est INCOMPLETE, pas invalide', async () => {
    const d = routeur('TI');
    const out = await conf(d, 'interface Tunnel0', 'tunnel mode gre');
    expect(out).toContain('% Incomplete command.');
  });
});

describe('un mode d authentification RIP est `text` ou `md5`', () => {
  it.each(['zorglub', 'sha', 'clear'])('`ip rip authentication mode %s` est refuse', async (mode) => {
    const d = routeur(`A${mode}`);
    expect(await conf(d, 'interface GigabitEthernet0/0',
      `ip rip authentication mode ${mode}`)).toContain('%');
  });

  it.each(['text', 'md5'])('`ip rip authentication mode %s` est accepte', async (mode) => {
    const d = routeur(`AO${mode}`);
    expect(await conf(d, 'interface GigabitEthernet0/0',
      `ip rip authentication mode ${mode}`)).not.toContain('%');
  });
});

describe('un numero d AS d agregation EIGRP est un nombre', () => {
  it('`ip summary-address eigrp zorglub …` est refuse', async () => {
    const d = routeur('S1');
    expect(await conf(d, 'interface GigabitEthernet0/0',
      'ip summary-address eigrp zorglub 10.0.0.0 255.0.0.0')).toContain('%');
  });

  it('et rien n en reste dans la configuration', async () => {
    const d = routeur('S2');
    await conf(d, 'interface GigabitEthernet0/0',
      'ip summary-address eigrp zorglub 10.0.0.0 255.0.0.0');
    expect(await config(d)).not.toContain('zorglub');
  });

  it('`ip summary-address eigrp 1 10.0.0.0 255.0.0.0` reste accepte et RELU', async () => {
    const d = routeur('S3');
    expect(await conf(d, 'interface GigabitEthernet0/0',
      'ip summary-address eigrp 1 10.0.0.0 255.0.0.0')).not.toContain('%');
    expect(await config(d)).toContain('ip summary-address eigrp 1 10.0.0.0 255.0.0.0');
  });

  it('et une adresse impossible est refusee aussi', async () => {
    const d = routeur('S4');
    expect(await conf(d, 'interface GigabitEthernet0/0',
      'ip summary-address eigrp 1 zorglub 255.0.0.0')).toContain('%');
  });
});

describe('`udld port` n a qu une option', () => {
  it.each(['zorglub', 'passive'])('`udld port %s` est refuse', async (mot) => {
    const d = commutateur(`U${mot}`);
    expect(await conf(d, 'interface GigabitEthernet0/1', `udld port ${mot}`)).toContain('%');
  });

  it.each(['', 'aggressive'])('`udld port %s` est accepte', async (mot) => {
    const d = commutateur(`UO${mot || 'nu'}`);
    expect(await conf(d, 'interface GigabitEthernet0/1',
      `udld port ${mot}`.trim())).not.toContain('%');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`tunnel source` et `tunnel destination` restent acceptees', async () => {
    const d = routeur('XA');
    await conf(d, 'interface Tunnel0',
      'tunnel source GigabitEthernet0/0', 'tunnel destination 10.0.0.2');
    const cfg = await config(d);
    expect(cfg).toContain('tunnel source GigabitEthernet0/0');
    expect(cfg).toContain('tunnel destination 10.0.0.2');
  });

  it('`ip rip authentication key-chain` reste acceptee', async () => {
    const d = routeur('XB');
    expect(await conf(d, 'interface GigabitEthernet0/0',
      'ip rip authentication key-chain KC')).not.toContain('%');
  });

  it('et `udld` global reste accepte', async () => {
    const d = commutateur('XC');
    expect(await conf(d, 'udld enable')).not.toContain('%');
  });
});

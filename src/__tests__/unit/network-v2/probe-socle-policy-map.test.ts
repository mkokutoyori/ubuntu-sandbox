/**
 * Une politique de trafic se RELIT, et une reserve de bande passante est
 * un nombre.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference IOS
 * (MQC) :
 *
 *   policy-map <nom>
 *     class {<nom de class-map> | class-default}
 *       bandwidth {<kbps> | percent <1-100> | remaining percent <1-100>}
 *       priority {<kbps> | percent <1-100>}
 *       police <bps> [<rafale>] [<rafale max>]
 *       shape {average | peak} <bps>
 *       queue-limit <paquets>
 *       set {dscp | precedence | cos} <valeur>
 *       fair-queue / random-detect / service-policy <nom>
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   bandwidth 2000        -> ACCEPTE, rendu NULLE PART
 *   priority 100          -> ACCEPTE, rendu NULLE PART
 *   queue-limit 40        -> ACCEPTE, rendu NULLE PART
 *   shape average 128000  -> ACCEPTE, rendu NULLE PART
 *   fair-queue            -> ACCEPTE, rendu NULLE PART
 *   police 8000 1500 2000 -> ACCEPTE, et RENDU
 *
 * Une seule action sur six se relit. La consequence depasse l'affichage,
 * la configuration rendue etant REJOUEE a l'import d'une topologie : une
 * politique de qualite de service revient en `class CM` VIDE, c'est-a-dire
 * une classe qui ne reserve rien, ne limite rien et ne met en forme rien,
 * alors que `show running-config` la decrivait comme configuree.
 *
 * Et rien n'est juge :
 *
 *   bandwidth zorglub     -> ACCEPTE
 *   bandwidth percent 250 -> ACCEPTE (un pourcentage au-dessus de cent)
 *   queue-limit zorglub   -> ACCEPTE
 *
 * `set dscp`, `set precedence` et `set cos` sont DEJA juges (mesure :
 * `set precedence 99` est refuse avec son caret), donc ce lot ne les
 * touche pas — ils sont ici comme TEMOINS.
 *
 * Ce que la sonde ne demande PAS, et pourquoi : la borne haute de
 * `bandwidth <kbps>` et de `priority <kbps>` depend de la plate-forme et
 * la documentation de Cisco n'est pas atteignable depuis ce reseau ; elle
 * est inscrite au `TODO.md` plutot que devinee. Un jeton NON NUMERIQUE,
 * lui, se refuse sans table, et un pourcentage au-dessus de cent aussi.
 * Elle ne demande pas non plus que `bandwidth percent ?` nomme le
 * POURCENTAGE : une place `REST` ne porte qu'UNE description et ne sait
 * pas quelle forme vient d'etre tapee — manquement deja mesure et inscrit
 * au `TODO.md` par les lots SNMP et NTP, et qui n'appartient pas a cette
 * famille. Ce qui est demande ici est que `bandwidth ?` annonce ses trois
 * FORMES, ce que le mecanisme sait faire et ne faisait pas.
 *
 * Discrimine par `git stash` sur les sept fichiers cables : 21 des 30 cas
 * tombent avant correctif. Les 9 autres sont nommes ici, chacun avec la
 * raison pour laquelle il ne pouvait pas discriminer :
 *
 *   - `police 8000 1500 2000` et `set precedence 5` rendues, et les deux
 *     cas de non-regression qui les reprennent : ce sont les deux SEULES
 *     actions sur sept que l'ancienne chaine de `else if` savait ecrire,
 *     donc les TEMOINS de ce lot ;
 *   - les trois `set {precedence|cos|dscp} 99` refusees : elles l'etaient
 *     deja, et sont ici pour borner le refus ajoute — sans elles, un
 *     analyseur refusant TOUT satisferait la sonde ;
 *   - `policy-map` et `class` rendues : l'ossature etait juste, c'est le
 *     CORPS de la classe qui manquait ;
 *   - « un refus ne laisse RIEN dans la classe » : avant correctif rien
 *     n'etait rendu du tout, donc l'absence etait vraie pour une mauvaise
 *     raison ;
 *   - « rejouer la configuration rendue redonne la meme configuration » :
 *     ET C'EST LE CAS LE PLUS INSTRUCTIF DE LA LISTE. Un aller-retour est
 *     TRIVIALEMENT vrai quand presque rien n'est rendu — l'ancienne
 *     configuration ne portait que `set precedence 5`, qui se rejoue tres
 *     bien. Un test d'aller-retour ne prouve donc rien tant qu'un autre
 *     cas n'a pas etabli que le rendu est COMPLET.
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

async function conf(d: Dev, ...cmds: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const c of ['enable', 'configure terminal', ...cmds]) {
    out.push(String(await d.executeCommand(c)));
  }
  return out.slice(2);
}

async function bloc(d: Dev): Promise<string[]> {
  await d.executeCommand('end');
  const cfg = String(await d.executeCommand('show running-config'));
  await d.executeCommand('configure terminal');
  const lignes: string[] = [];
  let dedans = false;
  for (const l of cfg.split('\n')) {
    if (/^policy-map /.test(l)) { dedans = true; lignes.push(l.replace(/\s+$/, '')); continue; }
    if (dedans && /^\s/.test(l)) lignes.push(l.replace(/\s+$/, ''));
    else if (dedans) dedans = false;
  }
  return lignes;
}

async function classe(d: Dev, ...actions: string[]): Promise<void> {
  await conf(d, 'class-map match-all CM', 'match any', 'exit',
    'policy-map PM', 'class CM', ...actions, 'exit', 'exit');
}

async function dansLaClasse(d: Dev, cmd: string): Promise<string> {
  const sorties = await conf(d, 'class-map match-all CM', 'match any', 'exit',
    'policy-map PM', 'class CM', cmd);
  return sorties[sorties.length - 1];
}

describe('chaque action de la classe se RELIT', () => {
  const ACTIONS = [
    'bandwidth 2000',
    'priority 100',
    'queue-limit 40',
    'shape average 128000',
    'police 8000 1500 2000',
    'set precedence 5',
    'fair-queue',
  ];

  it.each(ACTIONS)('`%s` revient dans la configuration', async (action) => {
    const d = routeur(`A${ACTIONS.indexOf(action)}`);
    await classe(d, action);
    expect((await bloc(d)).map((l) => l.trim())).toContain(action);
  });

  it('et toutes ensemble, sous la meme classe', async () => {
    const d = routeur('AT');
    await classe(d, ...ACTIONS);
    const lignes = (await bloc(d)).map((l) => l.trim());
    for (const action of ACTIONS) expect(lignes, action).toContain(action);
  });

  it('la classe est bien celle qui les porte', async () => {
    const d = routeur('AC');
    await classe(d, 'bandwidth 2000');
    const lignes = await bloc(d);
    expect(lignes[0]).toBe('policy-map PM');
    expect(lignes[1]).toBe(' class CM');
    expect(lignes[2]).toBe('  bandwidth 2000');
  });
});

describe('ce qui est rendu se REJOUE', () => {
  it('rejouer la configuration rendue redonne la meme configuration', async () => {
    const source = routeur('RA');
    await classe(source, 'bandwidth 2000', 'queue-limit 40',
      'shape average 128000', 'set precedence 5');
    const rendu = await bloc(source);

    const copie = routeur('RB');
    await conf(copie, 'class-map match-all CM', 'match any', 'exit');
    const refus = await conf(copie, ...rendu.map((l) => l.trim()), 'exit', 'exit');
    expect(refus.join('\n')).not.toContain('%');
    expect(await bloc(copie)).toEqual(rendu);
  });
});

describe('une reserve de bande passante est un nombre', () => {
  const MAUVAISES = [
    'bandwidth zorglub',
    'priority zorglub',
    'queue-limit zorglub',
    'shape average zorglub',
  ];

  it.each(MAUVAISES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`M${MAUVAISES.indexOf(cmd)}`);
    const out = await dansLaClasse(d, cmd);
    expect(String(out)).toContain('%');
  });

  it('et un refus ne laisse RIEN dans la classe', async () => {
    const d = routeur('MR');
    await classe(d, ...MAUVAISES);
    expect((await bloc(d)).join('\n')).not.toContain('zorglub');
  });
});

describe('un pourcentage ne depasse pas cent', () => {
  const HORS_BORNES = [
    'bandwidth percent 250',
    'bandwidth percent 0',
    'priority percent 250',
    'bandwidth remaining percent 250',
  ];

  it.each(HORS_BORNES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`P${HORS_BORNES.indexOf(cmd)}`);
    const out = await dansLaClasse(d, cmd);
    expect(String(out)).toContain('%');
  });

  const DANS_BORNES = ['bandwidth percent 30', 'priority percent 30'];

  it.each(DANS_BORNES)('`%s` est accepte et RELU', async (cmd) => {
    const d = routeur(`PB${DANS_BORNES.indexOf(cmd)}`);
    await classe(d, cmd);
    expect((await bloc(d)).map((l) => l.trim())).toContain(cmd);
  });

  it('`bandwidth percent` sans valeur est incomplete', async () => {
    const d = routeur('PI');
    const out = await dansLaClasse(d, 'bandwidth percent');
    expect(String(out)).toContain('% Incomplete command.');
  });
});

describe('l aide annonce les FORMES de la place', () => {
  it('`bandwidth ?` annonce les trois formes', async () => {
    const d = routeur('HA');
    const aide = String(await dansLaClasse(d, 'bandwidth ?'));
    expect(aide).toContain('<kbps>');
    expect(aide).toContain('percent');
    expect(aide).toContain('remaining');
  });

  it('`priority ?` en annonce deux, sans `remaining`', async () => {
    const d = routeur('HB');
    const aide = String(await dansLaClasse(d, 'priority ?'));
    expect(aide).toContain('percent');
    expect(aide).not.toContain('remaining');
  });

  it('`shape ?` annonce `average` et `peak`', async () => {
    const d = routeur('HC');
    const aide = String(await dansLaClasse(d, 'shape ?'));
    expect(aide).toContain('average');
    expect(aide).toContain('peak');
  });
});

describe('non-regression — ce que la famille jugeait deja', () => {
  const DEJA_JUGEES = ['set precedence 99', 'set cos 99', 'set dscp 99'];

  it.each(DEJA_JUGEES)('`%s` reste refuse', async (cmd) => {
    const d = routeur(`N${DEJA_JUGEES.indexOf(cmd)}`);
    const out = await dansLaClasse(d, cmd);
    expect(String(out)).toContain('%');
  });

  it('`police` reste acceptee et rendue', async () => {
    const d = routeur('NP');
    await classe(d, 'police 8000 1500 2000');
    expect((await bloc(d)).map((l) => l.trim())).toContain('police 8000 1500 2000');
  });

  it('`policy-map` et `class` restent rendues', async () => {
    const d = routeur('NC');
    await classe(d, 'set precedence 5');
    const lignes = (await bloc(d)).map((l) => l.trim());
    expect(lignes).toContain('policy-map PM');
    expect(lignes).toContain('class CM');
  });
});

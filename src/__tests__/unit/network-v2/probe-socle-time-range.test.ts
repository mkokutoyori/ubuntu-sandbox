/**
 * Une plage horaire qui n'existe pas ne rentre pas dans le magasin.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference IOS :
 *
 *   time-range <nom>
 *     periodic {Monday|...|Sunday|daily|weekdays|weekend}+ hh:mm to
 *              [{Monday|...}+] hh:mm
 *     absolute [start hh:mm jour mois annee] [end hh:mm jour mois annee]
 *
 * Les jours se LISTENT (`periodic Monday Wednesday Friday 8:00 to 17:00`),
 * l'heure est en 24 h (0-23 / 0-59), l'annee tient entre 1993 et 2035, le
 * mois se nomme en toutes lettres ou s'abrege, et une plage ne porte qu'UNE
 * entree `absolute` pour plusieurs `periodic`.
 *
 * UNE PREMISSE DE DEPART S'EST REVELEE FAUSSE ET EST ECRITE ICI plutot
 * qu'effacee : le balayage avait releve `08:00` rendu `8:00` et l'avait pris
 * pour une deformation. C'est l'INVERSE — IOS normalise l'heure a
 * l'affichage, ses propres exemples de configuration ecrivant
 * `periodic weekdays 8:00 to 18:00`. Le simulateur avait donc raison, et
 * un cas ci-dessous le FIXE pour qu'on ne le « corrige » pas plus tard.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   periodic zorglub 08:00 to 17:00   -> ACCEPTE, rendu ` periodic zorglub
 *                                        8:00 to 17:00` — un jour de la
 *                                        semaine invente
 *   absolute start zorglub            -> ACCEPTE, rendu NULLE PART
 *
 * La consequence depasse l'affichage : la configuration rendue est REJOUEE
 * a l'import d'une topologie, donc une plage `absolute` disparait entiere
 * et une plage `periodic` revient avec un jour qu'aucune horloge ne peut
 * atteindre — la liste de controle qu'elle gouverne ne s'ouvre alors
 * JAMAIS, sans un mot pour le dire.
 *
 * Discrimine par `git stash` sur les huit fichiers cables : 24 des 44 cas
 * tombent avant correctif. Les 20 autres sont nommes ici plutot que
 * laisses a decouvrir, chacun avec la raison pour laquelle il ne pouvait
 * pas discriminer :
 *
 *   - les six `periodic <jours valides>` et les deux cas de l'heure
 *     rendue : ce sont les TEMOINS. La famille les acceptait deja et les
 *     rendait deja, `08:00` compris — sans eux, un analyseur qui
 *     refuserait TOUT satisferait la sonde ;
 *   - `absolute start ... [end ...]` rendue dans la configuration : le
 *     rendu de la borne de DEBUT etait juste ; seule la borne `end`
 *     SEULE etait perdue, son unique ecriture etant gardee par
 *     `if (a.start)` ;
 *   - `absolute end 17:00 ...` acceptee et le mois abrege accepte : rien
 *     n'etait juge de ce cote, donc tout passait, y compris ce qui est
 *     valide ;
 *   - les deux cas du COMMUTATEUR qui refusent : ils passaient parce que
 *     le Catalyst n'avait AUCUNE plage horaire — `time-range`,
 *     `periodic`, `absolute` et `show time-range` repondaient toutes
 *     `% Invalid input`. Un refus par absence de commande n'est pas le
 *     refus d'un argument, et c'est le cas « il RELIT ce qu il accepte »
 *     qui le distingue ;
 *   - `time-range OUVERTURE` nommee dans la configuration et
 *     `show time-range` qui la decrit : ce que la famille faisait deja ;
 *   - `no absolute` et `absolute` seule : la premiere ne pouvait pas
 *     laisser de borne puisque aucune n'etait posee, la seconde etait
 *     deja incomplete.
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
  return cfg.split('\n')
    .filter((l) => /^time-range|^\s+(periodic|absolute)\s/.test(l))
    .map((l) => l.replace(/\s+$/, ''));
}

describe('`periodic` n accepte que des jours qui existent', () => {
  const JOURS_INVENTES = [
    'periodic zorglub 8:00 to 17:00',
    'periodic Mardi 8:00 to 17:00',
    'periodic weekdayz 8:00 to 17:00',
    'periodic Monday zorglub 8:00 to 17:00',
  ];

  it.each(JOURS_INVENTES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`PJ${JOURS_INVENTES.indexOf(cmd)}`);
    const [, out] = await conf(d, 'time-range OUVERTURE', cmd);
    expect(out).toContain('%');
  });

  it('et un jour invente ne laisse RIEN dans la configuration', async () => {
    const d = routeur('PJR');
    await conf(d, 'time-range OUVERTURE', ...JOURS_INVENTES, 'exit');
    expect((await bloc(d)).join('\n')).not.toContain('periodic');
  });

  const JOURS_VALIDES = [
    'daily',
    'weekdays',
    'weekend',
    'Monday',
    'Sunday',
    'Monday Wednesday Friday',
  ];

  it.each(JOURS_VALIDES)('`periodic %s 8:00 to 17:00` est accepte et RELU', async (jours) => {
    const d = routeur(`PV${JOURS_VALIDES.indexOf(jours)}`);
    const [, out] = await conf(d, 'time-range OUVERTURE', `periodic ${jours} 8:00 to 17:00`);
    expect(out).not.toContain('%');
    expect((await bloc(d)).map((l) => l.trim()))
      .toContain(`periodic ${jours} 8:00 to 17:00`);
  });
});

describe('`periodic` n accepte que des heures qui existent', () => {
  const HEURES_INVALIDES = [
    'periodic weekdays 25:00 to 17:00',
    'periodic weekdays 8:60 to 17:00',
    'periodic weekdays zorglub to 17:00',
    'periodic weekdays 8:00 to zorglub',
    'periodic weekdays 8:00 to 25:00',
    'periodic weekdays 800 to 17:00',
  ];

  it.each(HEURES_INVALIDES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`PH${HEURES_INVALIDES.indexOf(cmd)}`);
    const [, out] = await conf(d, 'time-range OUVERTURE', cmd);
    expect(out).toContain('%');
  });

  it('le mot `to` est exige', async () => {
    const d = routeur('PT');
    const [, out] = await conf(d, 'time-range OUVERTURE', 'periodic weekdays 8:00 zorglub 17:00');
    expect(out).toContain('%');
  });
});

describe('l heure se rend comme IOS la rend', () => {
  it('`08:00` revient `8:00`, sans zero de tete', async () => {
    const d = routeur('HN');
    await conf(d, 'time-range OUVERTURE', 'periodic weekdays 08:00 to 17:00', 'exit');
    expect((await bloc(d)).map((l) => l.trim()))
      .toContain('periodic weekdays 8:00 to 17:00');
  });

  it('et la minute garde le sien', async () => {
    const d = routeur('HM');
    await conf(d, 'time-range OUVERTURE', 'periodic weekdays 8:05 to 17:00', 'exit');
    expect((await bloc(d)).map((l) => l.trim()))
      .toContain('periodic weekdays 8:05 to 17:00');
  });
});

describe('`absolute` est retenue, jugee, et RELUE', () => {
  it('elle revient dans la configuration', async () => {
    const d = routeur('AA');
    await conf(d, 'time-range CHANTIER', 'absolute start 8:00 15 March 2017', 'exit');
    expect((await bloc(d)).join('\n')).toContain('absolute start');
  });

  it('avec sa date entiere', async () => {
    const d = routeur('AB');
    await conf(d, 'time-range CHANTIER', 'absolute start 8:00 15 March 2017', 'exit');
    const ligne = (await bloc(d)).find((l) => l.includes('absolute')) ?? '';
    expect(ligne).toContain('15 March 2017');
  });

  it('et les deux bornes quand les deux sont donnees', async () => {
    const d = routeur('AC');
    await conf(d, 'time-range CHANTIER',
      'absolute start 8:00 15 March 2017 end 17:00 20 March 2017', 'exit');
    const ligne = (await bloc(d)).find((l) => l.includes('absolute')) ?? '';
    expect(ligne).toContain('15 March 2017');
    expect(ligne).toContain('20 March 2017');
  });

  it('la forme `end` seule est acceptee', async () => {
    const d = routeur('AD');
    const [, out] = await conf(d, 'time-range CHANTIER', 'absolute end 17:00 20 March 2017');
    expect(out).not.toContain('%');
  });

  it('le mois s abrege', async () => {
    const d = routeur('AE');
    const [, out] = await conf(d, 'time-range CHANTIER', 'absolute start 8:00 15 Mar 2017');
    expect(out).not.toContain('%');
  });

  const ABSOLUES_INVALIDES = [
    'absolute start zorglub',
    'absolute zorglub',
    'absolute start 8:00 15 Zorglub 2017',
    'absolute start 8:00 32 March 2017',
    'absolute start 8:00 0 March 2017',
    'absolute start 8:00 15 March 1990',
    'absolute start 8:00 15 March 2040',
    'absolute start 25:00 15 March 2017',
    'absolute start 8:00 15 March zorglub',
  ];

  it.each(ABSOLUES_INVALIDES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`AI${ABSOLUES_INVALIDES.indexOf(cmd)}`);
    const [, out] = await conf(d, 'time-range CHANTIER', cmd);
    expect(out).toContain('%');
  });

  it('et un refus ne laisse AUCUNE borne dans la configuration', async () => {
    const d = routeur('AR');
    await conf(d, 'time-range CHANTIER', ...ABSOLUES_INVALIDES, 'exit');
    expect((await bloc(d)).join('\n')).not.toContain('absolute');
  });
});

describe('ce qui est rendu se RELIT', () => {
  it('rejouer la configuration rendue redonne la meme configuration', async () => {
    const source = routeur('RA');
    await conf(source, 'time-range OUVERTURE',
      'periodic weekdays 08:00 to 17:00',
      'periodic weekend 10:00 to 14:00',
      'absolute start 8:00 15 March 2017 end 17:00 20 March 2017', 'exit');
    const rendu = await bloc(source);

    const copie = routeur('RB');
    const refus = await conf(copie, ...rendu.map((l) => l.trim()));
    expect(refus.join('\n')).not.toContain('%');
    expect(await bloc(copie)).toEqual(rendu);
  });
});

describe('le commutateur juge comme le routeur', () => {
  it('il refuse le jour invente', async () => {
    const d = commutateur('SJ');
    const [, out] = await conf(d, 'time-range OUVERTURE', 'periodic zorglub 8:00 to 17:00');
    expect(out).toContain('%');
  });

  it('il refuse la date inventee', async () => {
    const d = commutateur('SD');
    const [, out] = await conf(d, 'time-range CHANTIER', 'absolute start zorglub');
    expect(out).toContain('%');
  });

  it('et il RELIT ce qu il accepte', async () => {
    const d = commutateur('SR');
    await conf(d, 'time-range OUVERTURE', 'periodic weekdays 8:00 to 17:00', 'exit');
    expect((await bloc(d)).map((l) => l.trim()))
      .toContain('periodic weekdays 8:00 to 17:00');
  });
});

describe('non-regression — ce que la famille faisait deja', () => {
  it('`time-range` cree la plage et la nomme dans la configuration', async () => {
    const d = routeur('XA');
    await conf(d, 'time-range OUVERTURE', 'exit');
    expect(await bloc(d)).toContain('time-range OUVERTURE');
  });

  it('`show time-range` la decrit toujours', async () => {
    const d = routeur('XB');
    await conf(d, 'time-range OUVERTURE', 'periodic weekdays 8:00 to 17:00', 'exit');
    await d.executeCommand('end');
    expect(String(await d.executeCommand('show time-range'))).toContain('OUVERTURE');
  });

  it('`no time-range` la retire toujours', async () => {
    const d = routeur('XC');
    await conf(d, 'time-range OUVERTURE', 'periodic weekdays 8:00 to 17:00', 'exit',
      'no time-range OUVERTURE');
    expect((await bloc(d)).join('\n')).not.toContain('OUVERTURE');
  });
});

describe('`no absolute` retire la borne sans la reecrire', () => {
  it('elle disparait de la configuration', async () => {
    const d = routeur('NA1');
    await conf(d, 'time-range CHANTIER', 'absolute start 8:00 15 March 2017',
      'no absolute', 'exit');
    expect((await bloc(d)).join('\n')).not.toContain('absolute');
  });

  it('et `absolute` seule reste incomplete', async () => {
    const d = routeur('NA2');
    const [, out] = await conf(d, 'time-range CHANTIER', 'absolute');
    expect(out).toContain('% Incomplete command.');
  });
});

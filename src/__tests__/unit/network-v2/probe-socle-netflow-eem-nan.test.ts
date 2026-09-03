/**
 * Une configuration ne contient JAMAIS le mot `NaN`.
 *
 * Sonde ecrite AVANT lecture du gestionnaire, contre la reference IOS :
 *
 *   ip flow-export destination <adresse> <port UDP>
 *   ip flow-export version {1 | 5 | 9}
 *   ip flow-cache timeout active <minutes>
 *   ip flow-cache timeout inactive <secondes>
 *   event manager applet <nom>
 *     event timer watchdog time <secondes>
 *     event timer countdown time <secondes>
 *
 * Chacune de ces places attend un NOMBRE. Un port UDP tient de surcroit
 * sur SEIZE bits — fait de protocole (RFC 6335), pas table de
 * constructeur — donc 0 et 65536 n'en sont pas.
 *
 * Mesure de depart sur un routeur, en relisant la configuration :
 *
 *   ip flow-export destination 10.0.0.1 zorglub
 *                        -> ACCEPTE, rendu `... 10.0.0.1 NaN`
 *   ip flow-export version zorglub
 *                        -> ACCEPTE, rendu `ip flow-export version NaN`
 *   ip flow-cache timeout active zorglub    -> rendu `... active NaN`
 *   ip flow-cache timeout inactive zorglub  -> rendu `... inactive NaN`
 *   event timer watchdog time zorglub       -> rendu `... time NaN`
 *   event timer countdown time zorglub      -> rendu `... time NaN`
 *
 * Six commandes ecrivent `NaN` dans la configuration. La consequence
 * depasse l'affichage : cette configuration est REJOUEE a l'import d'une
 * topologie, et `NaN` n'est pas une valeur qu'une machine puisse relire —
 * l'export NetFlow et la politique EEM reviennent donc dans un etat que
 * personne n'a configure, en silence.
 *
 * Six AUTRES places du meme fichier lisent `parseInt` sans garde et sont
 * DEJA refusees en amont (`transport udp`, `template data timeout`,
 * `cache timeout active|inactive`, `cache entries`, `action ... wait`) :
 * elles sont ici en TEMOINS, pour que le lot ne se contente pas de
 * refuser tout ce qui bouge.
 *
 * Ce que la sonde ne demande PAS : les bornes de `ip flow-cache timeout`
 * (minutes et secondes) dependent de la plate-forme et la documentation
 * de Cisco n'est pas atteignable depuis ce reseau ; elles sont inscrites
 * au `TODO.md` plutot que devinees. Un jeton NON NUMERIQUE, lui, se
 * refuse sans table.
 *
 * Discrimine par `git stash` sur le SEUL fichier cable : 10 des 23 cas
 * tombent avant correctif. Les 13 autres sont nommes ici :
 *
 *   - les six cas de non-regression `flow exporter` / `flow monitor` /
 *     `action ... wait` : ils etaient DEJA refuses, en amont du
 *     gestionnaire, et c'est precisement ce qui rend le lot mesurable —
 *     six `parseInt` sans garde sont vivants, six sont hors d'atteinte,
 *     et un lot qui refuserait TOUT ne se distinguerait pas ;
 *   - les cinq cas de valeurs JUSTES (version 5, les deux minuteurs de
 *     cache, le port 2055, le minuteur EEM) : ils passaient deja, et
 *     bornent le refus ajoute par le haut ;
 *   - la politique EEM complete et l'enregistrement NetFlow moderne :
 *     ce que la famille faisait deja et que ce lot ne doit pas casser.
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

const GLOBALES = [
  'ip flow-export destination 10.0.0.1 zorglub',
  'ip flow-export version zorglub',
  'ip flow-cache timeout active zorglub',
  'ip flow-cache timeout inactive zorglub',
];

const EEM = [
  'event timer watchdog time zorglub',
  'event timer countdown time zorglub',
];

describe('un mot qui n est pas un nombre est refuse', () => {
  it.each(GLOBALES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`G${GLOBALES.indexOf(cmd)}`);
    expect(await conf(d, cmd)).toContain('%');
  });

  it.each(EEM)('`%s` est refuse', async (cmd) => {
    const d = routeur(`E${EEM.indexOf(cmd)}`);
    expect(await conf(d, 'event manager applet EA', cmd)).toContain('%');
  });
});

describe('la configuration ne contient JAMAIS `NaN`', () => {
  it('apres les six saisies fautives', async () => {
    const d = routeur('NAN');
    await conf(d, ...GLOBALES, 'event manager applet EA', ...EEM, 'exit');
    expect(await config(d)).not.toContain('NaN');
  });
});

describe('un port UDP tient sur seize bits', () => {
  const HORS_BORNES = [
    'ip flow-export destination 10.0.0.1 0',
    'ip flow-export destination 10.0.0.1 65536',
    'ip flow-export destination 10.0.0.1 99999',
  ];

  it.each(HORS_BORNES)('`%s` est refuse', async (cmd) => {
    const d = routeur(`U${HORS_BORNES.indexOf(cmd)}`);
    expect(await conf(d, cmd)).toContain('%');
  });

  it('et 2055 reste accepte et RELU', async () => {
    const d = routeur('UOK');
    await conf(d, 'ip flow-export destination 10.0.0.1 2055');
    expect(await config(d)).toContain('ip flow-export destination 10.0.0.1 2055');
  });
});

describe('les valeurs justes restent acceptees et RELUES', () => {
  const JUSTES: ReadonlyArray<readonly [string, string]> = [
    ['ip flow-export version 5', 'ip flow-export version 5'],
    ['ip flow-cache timeout active 30', 'ip flow-cache timeout active 30'],
    ['ip flow-cache timeout inactive 15', 'ip flow-cache timeout inactive 15'],
  ];

  it.each(JUSTES)('`%s` revient dans la configuration', async (cmd, ligne) => {
    const d = routeur(`J${JUSTES.findIndex(([c]) => c === cmd)}`);
    expect(await conf(d, cmd)).not.toContain('%');
    expect(await config(d)).toContain(ligne);
  });

  it('et les minuteurs EEM aussi', async () => {
    const d = routeur('JE');
    await conf(d, 'event manager applet EA', 'event timer watchdog time 60', 'exit');
    expect(await config(d)).toContain('event timer watchdog time 60');
  });
});

describe('non-regression — ce qui etait deja juge', () => {
  const DEJA: ReadonlyArray<readonly [string, string[]]> = [
    ['flow exporter', ['flow exporter E', 'transport udp zorglub']],
    ['flow exporter template', ['flow exporter E', 'template data timeout zorglub']],
    ['flow monitor active', ['flow monitor M', 'cache timeout active zorglub']],
    ['flow monitor inactive', ['flow monitor M', 'cache timeout inactive zorglub']],
    ['flow monitor entries', ['flow monitor M', 'cache entries zorglub']],
    ['eem wait', ['event manager applet A', 'event none', 'action 1.0 wait zorglub']],
  ];

  it.each(DEJA)('%s reste refuse', async (_nom, cmds) => {
    const d = routeur(`D${DEJA.findIndex(([n]) => n === _nom)}`);
    expect(await conf(d, ...cmds)).toContain('%');
  });

  it('une politique EEM complete se relit toujours', async () => {
    const d = routeur('DE');
    await conf(d, 'event manager applet SURVEILLE',
      'event timer watchdog time 60',
      'action 1.0 syslog msg "coucou"',
      'action 2.0 cli command "show version"', 'exit');
    const cfg = await config(d);
    expect(cfg).toContain('event manager applet SURVEILLE');
    expect(cfg).toContain('event timer watchdog time 60');
    expect(cfg).toContain('action 1.0 syslog msg "coucou"');
  });

  it('un enregistrement NetFlow moderne se relit toujours', async () => {
    const d = routeur('DN');
    await conf(d, 'flow record FR', 'match ipv4 source address',
      'collect counter bytes', 'exit');
    const cfg = await config(d);
    expect(cfg).toContain('flow record FR');
    expect(cfg).toContain('match ipv4 source address');
    expect(cfg).toContain('collect counter bytes');
  });
});

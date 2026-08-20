/**
 * Les commandes universelles ont une aide.
 *
 * Defaut mesure (audit completion, M3 et la premiere famille de G4) : la
 * liste du mode offre `exit`, `end`, `help`, `do` et `default`, et l'aide
 * propre de chacune repond `% Invalid input`.
 *
 *     (config)# do ?        -> % Invalid input detected at '^' marker.
 *     (config)# default ?   -> % Invalid input detected at '^' marker.
 *     (config)# exit ?      -> % Invalid input detected at '^' marker.
 *
 * La cause est UNE et elle explique les cinq : ces commandes sont
 * traitees AVANT l'arbre, par le repartiteur lui-meme, donc aucun noeud
 * ne les porte — et l'aide ne lit que l'arbre. Elles s'executent
 * parfaitement (`do show version` rend la version) et n'ont pas d'aide.
 *
 * Le cout est plus eleve pour `do` que pour les autres : l'aide de `do`
 * est la seule facon de decouvrir qu'on peut lancer une commande EXEC
 * sans quitter le mode configuration, ce qui est tout l'interet de `do`.
 *
 * Ce que chacune doit rendre est LU sur ce qu'elle fait, pas choisi :
 *
 *   `exit`/`end`/`help`  ne prennent aucun argument, donc `<cr>`.
 *   `do X`               execute X sur l'arbre PRIVILEGIE, donc son aide
 *                        est celle de cet arbre, a toute profondeur.
 *   `default X`          est execute comme `no X` — c'est ecrit dans le
 *                        repartiteur — donc son aide est celle de `no`.
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

type Dev = { cliHelp(s: string): string; executeCommand(c: string): Promise<string> };

const MOT = /^\s\s(\S+)\s\s/;
const offerts = (t: string): string[] =>
  t.includes('Invalid input') ? []
    : t.split('\n').map((l) => MOT.exec(l)?.[1]).filter((x): x is string => !!x);
const annonceCr = (t: string): boolean =>
  t.split('\n').some((l) => /^\s\s<cr>\s*$/.test(l));

let serie = 0;
async function neuf(prelude: readonly string[]): Promise<Dev> {
  const r = new CiscoRouter(`U${serie++}`) as unknown as Dev;
  await r.executeCommand('enable');
  for (const c of prelude) await r.executeCommand(c);
  return r;
}

describe('sans argument, l aide est `<cr>` et rien d autre', () => {
  it.each([
    ['exit', []],
    ['help', []],
    ['exit', ['configure terminal']],
    ['end', ['configure terminal']],
    ['help', ['configure terminal']],
    ['end', ['configure terminal', 'interface GigabitEthernet0/0']],
  ] as Array<[string, string[]]>)('`%s ?`', async (cmd, pre) => {
    const r = await neuf(pre);
    const aide = r.cliHelp(`${cmd} `);
    expect(aide, `${cmd} ?`).not.toContain('Invalid input');
    expect(annonceCr(aide), `${cmd} ?`).toBe(true);
    expect(offerts(aide), `${cmd} ?`).toEqual([]);
  });

  it('et la commande se valide vraiment — le `<cr>` tient sa promesse', async () => {
    const r = await neuf(['configure terminal']);
    expect(String(await r.executeCommand('end'))).not.toContain('Incomplete');
  });
});

describe('`do ?` rend l arbre EXEC, a toute profondeur', () => {
  it('au premier rang, les memes commandes que l EXEC privilegie', async () => {
    const r = await neuf(['configure terminal']);
    const o = offerts(r.cliHelp('do '));
    for (const attendu of ['show', 'ping', 'copy', 'clear', 'write']) {
      expect(o, attendu).toContain(attendu);
    }
  });

  it('et au rang suivant : `do show ?` rend les sous-commandes de `show`', async () => {
    const r = await neuf(['configure terminal']);
    const parDo = offerts(r.cliHelp('do show '));
    expect(parDo.length).toBeGreaterThan(5);
    for (const attendu of ['version', 'ip', 'running-config']) {
      expect(parDo, attendu).toContain(attendu);
    }
  });

  it('la liste est la MEME que celle de l EXEC — c est le meme arbre', async () => {
    const enConfig = await neuf(['configure terminal']);
    const enExec = await neuf([]);
    expect(offerts(enConfig.cliHelp('do show ')).sort())
      .toEqual(offerts(enExec.cliHelp('show ')).sort());
  });

  it('ce que `do ?` propose, `do` l execute', async () => {
    const r = await neuf(['configure terminal']);
    expect(String(await r.executeCommand('do show version'))).toContain('Cisco IOS Software');
  });

  it('et `do` n existe pas en EXEC, ou il n aurait rien a prefixer', async () => {
    const r = await neuf([]);
    expect(r.cliHelp('do ')).toContain('Invalid input');
  });
});

describe('`default ?` rend ce que `no` rend — c est la meme execution', () => {
  it('au premier rang', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('default ')).sort())
      .toEqual(offerts(r.cliHelp('no ')).sort());
  });

  it('et au rang suivant', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('default ip ')).sort())
      .toEqual(offerts(r.cliHelp('no ip ')).sort());
  });

  it('en mode interface aussi, ou la liste est autre', async () => {
    const r = await neuf(['configure terminal', 'interface GigabitEthernet0/0']);
    const o = offerts(r.cliHelp('default '));
    expect(o.length).toBeGreaterThan(0);
    expect(o.sort()).toEqual(offerts(r.cliHelp('no ')).sort());
  });

  it('et `default` n existe pas hors configuration', async () => {
    const r = await neuf([]);
    expect(r.cliHelp('default ')).toContain('Invalid input');
  });
});

describe('le commutateur repond la meme chose — meme repartiteur', () => {
  it('`do show ?` et `default ?` y vivent aussi', async () => {
    const s = new CiscoSwitch('switch-cisco', 'SWU') as unknown as Dev;
    for (const c of ['enable', 'configure terminal']) await s.executeCommand(c);
    expect(offerts(s.cliHelp('do show '))).toContain('version');
    expect(offerts(s.cliHelp('default ')).length).toBeGreaterThan(0);
    expect(annonceCr(s.cliHelp('end '))).toBe(true);
  });
});

describe('non-regression — la liste du mode garde ces mots', () => {
  it('la racine de la configuration les offre toujours', async () => {
    const r = await neuf(['configure terminal']);
    const racine = offerts(r.cliHelp(''));
    for (const m of ['do', 'default', 'end', 'exit', 'help']) expect(racine, m).toContain(m);
  });

  it('et un mot inconnu reste refuse', async () => {
    const r = await neuf(['configure terminal']);
    expect(r.cliHelp('doo ')).toContain('Invalid input');
    expect(r.cliHelp('do zzzz ')).toContain('Invalid input');
  });
});

describe('le mot PARTIEL derriere `do` est complete lui aussi', () => {
  it('`do sh?` liste `show`, comme dans l EXEC', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('do sh'))).toContain('show');
  });

  it('`do show ver?` liste `version`', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('do show ver'))).toContain('version');
  });

  it('mais `do?` reste une question sur le mot `do` lui-meme', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('do'))).toContain('do');
  });

  it('et `default ho?` suit `no`', async () => {
    const r = await neuf(['configure terminal']);
    expect(offerts(r.cliHelp('default ho'))).toEqual(offerts(r.cliHelp('no ho')));
  });
});

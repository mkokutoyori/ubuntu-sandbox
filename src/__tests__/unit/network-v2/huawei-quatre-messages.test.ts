/**
 * PRD-CLI-Fidelite-VRP.md §1.7-§1.8 / chantier D / lot V4 — quatre
 * messages, un format.
 *
 * VRP n'a que quatre erreurs positionnelles, et elles portent TOUTES
 * l'echo de la ligne et le curseur. Ce qui est verifie ici est donc une
 * FORME, balayee sur des dizaines de commandes, et non une liste de
 * chaines : n'importe quel refus positionnel doit tenir en trois lignes
 * — le message, la ligne tapee, le curseur.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HuaweiRouter } from '@/network/devices/HuaweiRouter';
import { HuaweiSwitch } from '@/network/devices/HuaweiSwitch';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

let serie = 0;

interface Cli { executeCommand(c: string): Promise<string> }

async function dans(fabrique: () => Cli, vue: readonly string[]): Promise<Cli> {
  const d = fabrique();
  for (const c of vue) await d.executeCommand(c);
  return d;
}

const R = () => new HuaweiRouter(`QA${++serie}`) as Cli;
const S = () => new HuaweiSwitch(`QB${++serie}`) as Cli;

/** Les quatre familles, et rien d'autre. */
const FAMILLES = [
  'Unrecognized command', 'Incomplete command',
  'Wrong parameter', 'Too many parameters',
] as const;

/**
 * Un refus positionnel tient en trois lignes : le message, la ligne
 * tapee telle quelle, et le curseur. C'est la forme, pas le texte.
 */
function estBienForme(sortie: string, ligneTapee: string): void {
  const l = sortie.split('\n');
  expect(l.length, sortie).toBe(3);
  expect(FAMILLES.some((f) => l[0] === `Error: ${f} found at '^' position.`), l[0]).toBe(true);
  expect(l[1]).toBe(ligneTapee);
  expect(l[2]).toMatch(/^ *\^$/);
  expect(l[2].indexOf('^')).toBeLessThanOrEqual(ligneTapee.length);
}

const REFUS_ROUTEUR: ReadonlyArray<readonly [string[], string[]]> = [
  [['system-view'], [
    'zzz', 'ip zzz',
    'ip route-static', 'ip route-static 10.0.0.0', 'sysname', 'interface',
    'ip pool', 'ip host', 'acl', 'display',
    'ip route-static 999.0.0.0 255.0.0.0 10.0.12.2',
    'ip route-static 10.0.0.0 255.0.0.0 999.0.0.2',
    'ospf 0', 'ospf 65536',
    'interface LoopBack', 'interface GigabitEthernet9/9/9', 'interface zzz',
    'sysname R1 R2',
  ]],
  [['system-view', 'interface GigabitEthernet0/0/0'], [
    'ip address 999.1.1.1 255.255.255.0', 'zzz',
  ]],
];

describe('tout refus positionnel a la meme forme', () => {
  it.each(REFUS_ROUTEUR)('routeur, %j', async (vue, cmds) => {
    for (const c of cmds) {
      const r = await dans(R, vue);
      estBienForme(await r.executeCommand(c), c);
    }
  });

  it('switch, meme forme', async () => {
    for (const c of ['zzz', 'vlan', 'sysname A B', 'interface zzz']) {
      const s = await dans(S, ['system-view']);
      estBienForme(await s.executeCommand(c), c);
    }
  });

  it('le curseur designe le premier argument quand c\'est lui qui est faux', async () => {
    const r = await dans(R, ['system-view']);
    const l = (await r.executeCommand('ospf 0')).split('\n');
    expect(l[2].indexOf('^')).toBe(l[1].indexOf('0'));
  });

  it('le curseur va en fin de ligne quand il manque un argument', async () => {
    const r = await dans(R, ['system-view']);
    const l = (await r.executeCommand('sysname')).split('\n');
    expect(l[2].indexOf('^')).toBe('sysname'.length);
  });
});

describe('aucun message maison ne subsiste', () => {
  const MAISON = [
    /Invalid IP octet/, /Invalid OSPF process ID/,
    /Wrong parameter found\.$/, /^Error: Wrong parameter\.$/,
    /^Error: Incomplete command\.$/,
  ];

  it('les formulations inventees ont disparu des refus mesures', async () => {
    for (const [vue, cmds] of REFUS_ROUTEUR) {
      for (const c of cmds) {
        const r = await dans(R, vue);
        const out = await r.executeCommand(c);
        for (const m of MAISON) expect(out, `${c} / ${m}`).not.toMatch(m);
      }
    }
  });

  it('un message propre a une commande garde ses mots', async () => {
    const r = await dans(R, ['system-view']);
    // `Error: OSPF is not configured.` n'est pas une des quatre familles :
    // il n'a pas de position a montrer, donc on ne lui en invente pas.
    const out = await r.executeCommand('display ospf peer');
    if (out.startsWith('Error:')) expect(out.split('\n').length).toBe(1);
  });
});

describe('un parametre en trop est refuse la ou la forme est close', () => {
  it('`sysname` prend un nom, et un seul', async () => {
    for (const fabrique of [R, S]) {
      const d = await dans(fabrique, ['system-view']);
      const out = await d.executeCommand('sysname R1 R2');
      expect(out).toContain("Error: Too many parameters found at '^' position.");
      expect(out.split('\n')[2].indexOf('^')).toBe('sysname R1 '.length);
    }
  });

  it('le refus n\'a rien change', async () => {
    const r = await dans(R, ['system-view', 'sysname AVANT']);
    await r.executeCommand('sysname R1 R2');
    expect(await r.executeCommand('display current-configuration')).toContain('sysname AVANT');
  });

  it('la forme legitime passe toujours', async () => {
    const r = await dans(R, ['system-view']);
    expect(await r.executeCommand('sysname APRES')).toBe('');
    expect(await r.executeCommand('display current-configuration')).toContain('sysname APRES');
  });

  it('une commande a forme libre n\'est pas plafonnee', async () => {
    const r = await dans(R, ['system-view', 'interface GigabitEthernet0/0/0']);
    expect(await r.executeCommand('description ceci est une description longue'))
      .not.toMatch(/Too many parameters/);
  });
});

describe('ce que ce lot ne traite pas, et le dit', () => {
  it('les commandes sans plafond declare acceptent encore un mot en trop', async () => {
    const r = await dans(R, ['system-view']);
    // Plafonner a l'aveugle refuserait des formes legitimes, ce qui
    // serait pire que ce silence. Ces deux cas attendent une declaration
    // par commande (lot V5), et sont fixes ici pour qu'elle soit faite
    // sciemment.
    for (const c of ['ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 extra', 'ospf 1 zzz']) {
      expect(await r.executeCommand(c), c).not.toMatch(/Too many parameters/);
    }
  });
});

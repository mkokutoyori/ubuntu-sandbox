/**
 * PRD-CLI-Fidelite-VRP.md §1.4-§1.6 / chantier C / lot V3 — une seule
 * verite par objet.
 *
 * Trois proprietes, verifiees en comparant les vues ENTRE ELLES plutot
 * qu'a des chaines ecrites a la main :
 *
 * 1. Un port a UN nom, et c'est le nom complet, partout ou il paraît.
 * 2. Une interface virtuelle est vivante, et les vues s'accordent avec
 *    la table de routage.
 * 3. `display this` rend la vue courante — donc strictement moins que la
 *    configuration entiere des qu'on est descendu dans une vue.
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

interface Cli { executeCommand(c: string): Promise<string>; getPrompt?(): string }

async function run(d: Cli, cmds: readonly string[]): Promise<void> {
  for (const c of cmds) await d.executeCommand(c);
}

async function routeur(): Promise<HuaweiRouter> {
  const r = new HuaweiRouter(`NR${++serie}`);
  await run(r, ['system-view', 'sysname LAB',
    'interface GigabitEthernet0/0/0', 'ip address 10.0.12.1 255.255.255.0',
    'undo shutdown', 'quit',
    'interface LoopBack0', 'ip address 9.9.9.9 255.255.255.255', 'quit',
    'ospf 1 router-id 9.9.9.9', 'area 0', 'network 10.0.12.0 0.0.0.255', 'quit', 'quit',
    'rip 1', 'version 2', 'network 10.0.0.0', 'quit',
    'acl number 2000', 'rule 5 permit source 10.0.0.0 0.255.255.255', 'quit',
    'aaa', 'local-user zoe password irreversible-cipher Huawei@123', 'quit']);
  return r;
}

async function commutateur(): Promise<HuaweiSwitch> {
  const s = new HuaweiSwitch(`NS${++serie}`);
  await run(s, ['system-view', 'sysname SW', 'vlan 10', 'quit',
    'interface GigabitEthernet0/0/1', 'port link-type access',
    'port default vlan 10', 'quit']);
  return s;
}

/** Les vues qui NOMMENT une interface. */
const VUES_QUI_NOMMENT = [
  'display ip interface brief',
  'display interface brief',
  'display interface description',
  'display current-configuration',
  'display interface GigabitEthernet0/0/0',
] as const;

describe('un port a un seul nom', () => {
  it('toutes les vues qui le nomment emploient le nom complet', async () => {
    const r = await routeur();
    for (const v of VUES_QUI_NOMMENT) {
      const out = await r.executeCommand(v);
      expect(out, v).toContain('GigabitEthernet0/0/0');
      expect(out, `${v} ne doit pas montrer le nom interne`)
        .not.toMatch(/(^|\s)GE0\/0\/0(\s|$)/m);
    }
  });

  it('l\'invite emploie le meme nom que les vues', async () => {
    const r = await routeur();
    await r.executeCommand('interface GigabitEthernet0/0/0');
    expect(r.getPrompt()).toBe('[LAB-GigabitEthernet0/0/0]');
  });

  it('l\'abreviation d\'entree reste acceptee, seul l\'affichage change', async () => {
    const r = await routeur();
    await r.executeCommand('interface GE0/0/0');
    expect(r.getPrompt()).toBe('[LAB-GigabitEthernet0/0/0]');
  });
});

describe('une interface virtuelle est vivante', () => {
  it('la Loopback est vue vivante par toutes les vues qui la nomment', async () => {
    const r = await routeur();
    for (const v of ['display ip interface brief', 'display interface brief']) {
      const ligne = (await r.executeCommand(v)).split('\n').find((l) => l.startsWith('LoopBack0'));
      expect(ligne, v).toBeTruthy();
      expect(ligne, v).not.toMatch(/down/);
    }
    expect(await r.executeCommand('display interface LoopBack0')).toMatch(/current state : UP/);
  });

  it('sa route est installee, donc les vues et la table s\'accordent', async () => {
    const r = await routeur();
    expect(await r.executeCommand('display ip routing-table')).toContain('9.9.9.9');
  });

  it('une interface physique sans porteuse reste vue morte', async () => {
    const r = await routeur();
    const ligne = (await r.executeCommand('display ip interface brief'))
      .split('\n').find((l) => l.startsWith('GigabitEthernet0/0/0'));
    expect(ligne).toMatch(/down/);
  });

  it('un arret administratif se distingue d\'une porteuse absente', async () => {
    const r = await routeur();
    await run(r, ['interface GigabitEthernet0/0/1', 'shutdown', 'quit']);
    const brief = await r.executeCommand('display interface brief');
    const arretee = brief.split('\n').find((l) => l.startsWith('GigabitEthernet0/0/1'))!;
    const sansPorteuse = brief.split('\n').find((l) => l.startsWith('GigabitEthernet0/0/2'))!;
    expect(arretee).toMatch(/\*down/);
    expect(sansPorteuse).not.toMatch(/\*down/);
  });
});

describe('`display this` rend la vue courante', () => {
  const VUES_ROUTEUR = [
    ['interface', ['interface GigabitEthernet0/0/0'], /^interface GigabitEthernet0\/0\/0$/m],
    ['ospf', ['ospf 1'], /^ospf 1$/m],
    ['rip', ['rip 1'], /^rip 1$/m],
    ['aaa', ['aaa'], /^aaa$/m],
    ['acl', ['acl number 2000'], /^acl number 2000$/m],
  ] as const;

  it.each(VUES_ROUTEUR)('routeur, vue %s : strictement moins que la configuration', async (_n, entree, tete) => {
    const r = await routeur();
    const complet = await r.executeCommand('display current-configuration');
    await run(r, [...entree]);
    const ceci = await r.executeCommand('display this');

    expect(ceci).toMatch(tete);
    expect(ceci.split('\n').length).toBeLessThan(complet.split('\n').length);
    for (const ligne of ceci.split('\n')) {
      if (ligne === '#' || ligne === '') continue;
      expect(complet, `« ${ligne} » doit venir de la configuration`).toContain(ligne);
    }
  });

  it('routeur, vue aaa : les comptes sortent, le reste non', async () => {
    const r = await routeur();
    await r.executeCommand('aaa');
    const ceci = await r.executeCommand('display this');
    expect(ceci).toContain('local-user zoe');
    expect(ceci).not.toContain('sysname');
    expect(ceci).not.toContain('interface GigabitEthernet');
  });

  it('routeur, vue acl : seule l\'ACL choisie sort', async () => {
    const r = await routeur();
    await r.executeCommand('acl number 2000');
    const ceci = await r.executeCommand('display this');
    expect(ceci).toContain('rule 5 permit source 10.0.0.0 0.255.255.255');
    expect(ceci).not.toContain('local-user');
    expect(ceci).not.toContain('ospf 1');
  });

  it('switch, vue de VLAN : la commande existe et rend le VLAN', async () => {
    const s = await commutateur();
    await s.executeCommand('vlan 10');
    const ceci = await s.executeCommand('display this');
    expect(ceci).not.toMatch(/Unrecognized command/);
    expect(ceci).toContain('vlan 10');
    expect(ceci).not.toContain('sysname');
  });

  it('switch, vue d\'interface : seule l\'interface choisie sort', async () => {
    const s = await commutateur();
    await s.executeCommand('interface GigabitEthernet0/0/1');
    const ceci = await s.executeCommand('display this');
    expect(ceci).toContain('port default vlan 10');
    expect(ceci).not.toContain('GigabitEthernet0/0/2');
  });

  it('en vue systeme, la vue courante EST la machine', async () => {
    for (const d of [await routeur(), await commutateur()] as Cli[]) {
      const complet = await d.executeCommand('display current-configuration');
      expect(await d.executeCommand('display this')).toBe(complet);
    }
  });
});

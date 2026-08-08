/**
 * PRD-CLI-Fidelite-VRP.md §15 / lot V7 — la queue d'une commande est lue
 * jusqu'au bout.
 *
 * Un mot que la grammaire ne prevoit pas tombait dans le vide : sans
 * effet et SANS MESSAGE, la commande prenant comme s'il n'avait pas ete
 * tape. Deux mecanismes, parce que deux grammaires :
 *
 * 1. les formes positionnelles CLOSES declarent un plafond ;
 * 2. les queues a MOTS-CLES sont validees par leur parseur — y compter
 *    les arguments ne veut rien dire, `ip route-static … preference 100
 *    tag 7 permanent` en portant six de plus, tous legitimes.
 *
 * Le balayage verifie donc les DEUX cotes a chaque fois : ce qui est
 * legitime passe et PREND, ce qui est parasite est refuse et ne pose
 * rien. Un test qui ne verifierait que le refus laisserait passer un
 * plafond pose a l'aveugle, qui est le defaut inverse.
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
interface Cli { executeCommand(c: string): Promise<string>; getPrompt(): string }

async function dans(kind: 'R' | 'S', vue: readonly string[]): Promise<Cli> {
  const d = (kind === 'R'
    ? new HuaweiRouter(`Q${++serie}`)
    : new HuaweiSwitch('switch-huawei', `Q${++serie}`)) as unknown as Cli;
  for (const c of vue) await d.executeCommand(c);
  return d;
}

const REFUS = /^Error: (Wrong parameter|Incomplete command|Unrecognized command|Too many parameters) found at '\^' position\./;

/** Un refus positionnel tient en trois lignes, et le curseur designe un mot reel. */
function bienForme(sortie: string, ligne: string): void {
  const l = sortie.split('\n');
  expect(l.length, sortie).toBe(3);
  expect(l[0], sortie).toMatch(REFUS);
  expect(l[1]).toBe(ligne);
  expect(l[2]).toMatch(/^ *\^$/);
  expect(l[2].indexOf('^')).toBeLessThan(ligne.length);
}

/** [plateforme, vue, forme legitime, marqueur attendu dans la config] */
const LEGITIMES: ReadonlyArray<readonly ['R' | 'S', string[], string, string | null]> = [
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2', 'ip route-static 10.0.0.0'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 24 10.0.12.2', 'ip route-static 10.0.0.0'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 preference 100', 'preference 100'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 permanent', 'permanent'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 description VERS LE SIEGE', 'ip route-static 10.0.0.0'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 preference 100 tag 7 permanent', 'preference 100'],
  ['R', ['system-view'], 'ospf 1', 'ospf 1'],
  ['R', ['system-view'], 'ospf 1 router-id 1.1.1.1', 'router-id 1.1.1.1'],
  ['R', ['system-view'], 'ip host serveur 10.0.0.9', null],
  ['R', ['system-view'], 'ip pool POOL1', null],
  ['R', ['system-view'], 'rip 1', 'rip 1'],
  ['R', ['system-view'], 'interface GigabitEthernet0/0/0', 'interface GigabitEthernet0/0/0'],
  ['R', ['system-view'], 'interface LoopBack 3', 'interface LoopBack3'],
  ['R', ['system-view', 'interface GigabitEthernet0/0/0'], 'ip address 10.0.12.1 255.255.255.0', 'ip address 10.0.12.1 255.255.255.0'],
  ['R', ['system-view', 'interface GigabitEthernet0/0/0'], 'ip address 10.0.12.1 24', 'ip address 10.0.12.1 255.255.255.0'],
  ['R', ['system-view', 'interface GigabitEthernet0/0/0'], 'description LIEN VERS LE SIEGE', 'description LIEN VERS LE SIEGE'],
  ['R', ['system-view', 'ospf 1', 'area 0'], 'network 10.0.12.0 0.0.0.255', 'network 10.0.12.0'],
  ['R', ['system-view', 'rip 1'], 'network 10.0.0.0', 'network 10.0.0.0'],
  ['R', ['system-view', 'rip 1'], 'version 2', 'version 2'],
  ['S', ['system-view'], 'vlan 10', null],
  ['S', ['system-view'], 'vlan batch 10 20 30', null],
  ['S', ['system-view', 'vlan 10'], 'name VENTES', null],
  ['S', ['system-view', 'interface GigabitEthernet0/0/1'], 'port default vlan 10', 'port default vlan 10'],
];

/** [plateforme, vue, forme parasite] — le mot en trop est le dernier. */
const PARASITES: ReadonlyArray<readonly ['R' | 'S', string[], string]> = [
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 extra'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 preference 100 extra'],
  ['R', ['system-view'], 'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 zzz 5'],
  ['R', ['system-view'], 'ospf 1 zzz'],
  ['R', ['system-view'], 'ospf 1 router-id 1.1.1.1 extra'],
  ['R', ['system-view'], 'rip 1 extra'],
  ['R', ['system-view'], 'ip host serveur 10.0.0.9 extra'],
  ['R', ['system-view'], 'ip pool POOL1 extra'],
  ['R', ['system-view'], 'interface GigabitEthernet0/0/0 extra'],
  ['R', ['system-view'], 'interface LoopBack 3 extra'],
  ['R', ['system-view', 'interface GigabitEthernet0/0/0'], 'ip address 10.0.12.1 255.255.255.0 extra'],
  ['R', ['system-view', 'ospf 1', 'area 0'], 'network 10.0.12.0 0.0.0.255 extra'],
  ['R', ['system-view', 'ospf 1'], 'area 0 extra'],
  ['R', ['system-view', 'rip 1'], 'network 10.0.0.0 extra'],
  ['R', ['system-view', 'rip 1'], 'version 2 extra'],
  ['S', ['system-view'], 'vlan 10 extra'],
  ['S', ['system-view', 'vlan 10'], 'name DEUX MOTS'],
  ['S', ['system-view', 'interface GigabitEthernet0/0/1'], 'port default vlan 10 extra'],
];

describe('ce qui est legitime passe, et prend', () => {
  it.each(LEGITIMES)('%s %j %s', async (plat, vue, forme, marqueur) => {
    const d = await dans(plat, vue);
    // `vlan batch` rend une ligne d'information : ce qui compte est
    // qu'aucune forme legitime ne soit REFUSEE.
    expect(await d.executeCommand(forme), forme).not.toMatch(REFUS);
    if (marqueur) {
      const cfg = await d.executeCommand('display current-configuration');
      expect(cfg, forme).toContain(marqueur);
    }
  });
});

describe('un mot que la grammaire ne prevoit pas est refuse', () => {
  it.each(PARASITES)('%s %j %s', async (plat, vue, forme) => {
    const d = await dans(plat, vue);
    bienForme(await d.executeCommand(forme), forme);
  });

  it('le curseur designe le mot fautif, pas un mot juste', async () => {
    for (const [plat, vue, forme] of PARASITES) {
      const d = await dans(plat, vue);
      const l = (await d.executeCommand(forme)).split('\n');
      const fautif = forme.split(' ').slice(-1)[0] === 'MOTS' ? 'MOTS' : forme.split(' ').slice(-1)[0];
      const attendu = forme.lastIndexOf(fautif);
      // `zzz 5` : le fautif est `zzz`, pas le dernier mot.
      const pos = forme.includes(' zzz ') ? forme.indexOf('zzz') : attendu;
      expect(l[2].indexOf('^'), forme).toBe(pos);
    }
  });

  it('un refus ne pose rien', async () => {
    const r = await dans('R', ['system-view']);
    await r.executeCommand('ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 extra');
    await r.executeCommand('ospf 1 zzz');
    const cfg = await r.executeCommand('display current-configuration');
    expect(cfg).not.toContain('ip route-static');
    expect(cfg).not.toContain('ospf 1');
  });

  it('un refus n\'ecrase pas ce qui etait deja pose', async () => {
    const r = await dans('R', ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.12.1 255.255.255.0']);
    expect(await r.executeCommand('ip address 10.0.99.9 255.255.255.0 extra')).toMatch(REFUS);
    expect(await r.executeCommand('display this')).toContain('10.0.12.1');
  });

  it('un refus ne fait pas changer de vue', async () => {
    const r = await dans('R', ['system-view']);
    const avant = r.getPrompt();
    await r.executeCommand('ospf 1 zzz');
    expect(r.getPrompt()).toBe(avant);
    const s = await dans('S', ['system-view']);
    const avantS = s.getPrompt();
    await s.executeCommand('vlan 10 extra');
    expect(s.getPrompt()).toBe(avantS);
  });
});

describe('ce qui est libre le reste', () => {
  it('une description prend tous ses mots', async () => {
    const r = await dans('R', ['system-view', 'interface GigabitEthernet0/0/0']);
    expect(await r.executeCommand('description LIEN OPERATEUR NUMERO 42')).toBe('');
    expect(await r.executeCommand('display this')).toContain('LIEN OPERATEUR NUMERO 42');
  });

  it('la description d\'une route statique aussi', async () => {
    const r = await dans('R', ['system-view']);
    expect(await r.executeCommand(
      'ip route-static 10.0.0.0 255.0.0.0 10.0.12.2 description VERS LE SIEGE')).toBe('');
  });

  it('`vlan batch` prend une liste', async () => {
    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('vlan batch 10 20 30 40')).not.toMatch(REFUS);
  });
});

describe('ce que ce lot ne traite pas, et le dit', () => {
  it('deux gestionnaires gloutons multi-formes acceptent encore un mot en trop', async () => {
    // `acl` et `stp` portent PLUSIEURS grammaires sous un seul noeud
    // (`acl 2000` / `acl number 2000` / `acl name X advance` ;
    // `stp mode`, `stp priority`, `stp root`…). Leur poser un plafond
    // refuserait des formes legitimes, et ecrire leur grammaire est un
    // travail par commande, pas un plafond. Fixe ici pour que ce soit
    // fait sciemment le jour ou ce sera fait.
    const r = await dans('R', ['system-view']);
    expect(await r.executeCommand('acl 2000 extra')).not.toMatch(REFUS);
    const s = await dans('S', ['system-view']);
    expect(await s.executeCommand('stp mode rstp extra')).not.toMatch(REFUS);
  });

  it('`ip address … sub` est accepte et ne cree pas d\'adresse secondaire', async () => {
    // Le mot est desormais VALIDE (tout autre mot est refuse), mais la
    // machine n'a pas de notion d'adresse secondaire : la seconde
    // remplace la premiere. C'est un manque du plan de donnees, pas de
    // la CLI, et il est nomme plutot que masque.
    const r = await dans('R', ['system-view', 'interface GigabitEthernet0/0/0',
      'ip address 10.0.12.1 255.255.255.0']);
    expect(await r.executeCommand('ip address 10.0.12.9 255.255.255.0 sub')).toBe('');
    const vue = await r.executeCommand('display this');
    expect(vue).toContain('10.0.12.9');
    expect(vue).not.toContain('10.0.12.1');
  });
});

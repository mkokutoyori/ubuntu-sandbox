/**
 * PRD-CLI-Fidelite-VRP.md §1.1 / chantier B / lot V1 — `undo` cesse
 * d'etre un trou noir.
 *
 * Ce qui est verifie n'est pas une liste de mots refuses mais une
 * PROPRIETE : derriere `undo`, un mot que la vue ne connait pas est
 * refuse, et un mot qu'elle connait passe. Les deux balayages parcourent
 * donc les memes vues sur les deux plateformes.
 *
 * Le silence est la seule confirmation que VRP donne quand tout va bien.
 * Une faute de frappe qui rend la main sans un mot est donc pire qu'une
 * commande cassee : elle se fait passer pour un succes.
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

type Machine = HuaweiRouter | HuaweiSwitch;

async function dans(fabrique: () => Machine, vue: string[]): Promise<Machine> {
  const m = fabrique();
  for (const c of vue) await m.executeCommand(c);
  return m;
}

const ROUTEUR = () => new HuaweiRouter(`UR${++serie}`) as Machine;
const SWITCH = () => new HuaweiSwitch(`US${++serie}`) as Machine;

/** Les vues ou un `undo` se tape, sur chaque plateforme. */
const VUES_ROUTEUR: ReadonlyArray<readonly [string, string[]]> = [
  ['vue systeme', ['system-view']],
  ['vue d\'interface', ['system-view', 'interface GigabitEthernet0/0/0']],
  ['vue RIP', ['system-view', 'rip 1']],
];

const VUES_SWITCH: ReadonlyArray<readonly [string, string[]]> = [
  ['vue systeme', ['system-view']],
  ['vue d\'interface', ['system-view', 'interface GigabitEthernet0/0/1']],
  ['vue de VLAN', ['system-view', 'vlan 10']],
];

/**
 * Des mots qui ne sont une commande dans aucune vue — et qui ne sont
 * prefixe d'aucune non plus : VRP abrege, donc `shutdow` EST `shutdown`
 * et n'a rien a faire dans cette liste. La faute de frappe qu'un
 * operateur commet vraiment est une transposition, pas une troncature.
 */
const INCONNUS = ['zzz', 'nimportequoi', 'descriptoin', 'qwerty', 'shudown'];

describe('un mot inconnu derriere `undo` est refuse', () => {
  it.each(VUES_ROUTEUR)('routeur, %s', async (_nom, vue) => {
    for (const mot of INCONNUS) {
      const r = await dans(ROUTEUR, vue);
      const out = await r.executeCommand(`undo ${mot}`);
      expect(out, mot).toMatch(/^Error: Unrecognized command found at '\^' position\./);
    }
  });

  it.each(VUES_SWITCH)('switch, %s', async (_nom, vue) => {
    for (const mot of INCONNUS) {
      const s = await dans(SWITCH, vue);
      const out = await s.executeCommand(`undo ${mot}`);
      expect(out, mot).toMatch(/^Error: Unrecognized command found at '\^' position\./);
    }
  });

  it('le refus porte l\'echo de la ligne et le curseur sous le mot fautif', async () => {
    const r = await dans(ROUTEUR, ['system-view']);
    const lignes = (await r.executeCommand('undo zzzz')).split('\n');
    expect(lignes[0]).toBe("Error: Unrecognized command found at '^' position.");
    expect(lignes[1]).toBe('undo zzzz');
    expect(lignes[2]).toBe(' '.repeat('undo '.length) + '^');
  });

  it('les deux plateformes refusent avec le meme mot', async () => {
    const r = await dans(ROUTEUR, ['system-view']);
    const s = await dans(SWITCH, ['system-view']);
    const surR = await r.executeCommand('undo zzz');
    expect(await s.executeCommand('undo zzz')).toBe(surR);
    expect(surR).toMatch(/^Error: Unrecognized command found at '\^' position\./);
  });
});

describe('un `undo` legitime continue de passer', () => {
  const LEGITIMES: ReadonlyArray<readonly [string[], string[]]> = [
    [['system-view'], ['undo sysname', 'undo rip', 'undo dhcp enable',
      'undo stelnet server enable', 'undo telnet server enable',
      'undo ftp server enable', 'undo icmp', 'undo snmp-agent',
      'undo lldp', 'undo ntp-service', 'undo header', 'undo terminal monitor']],
    [['system-view', 'interface GigabitEthernet0/0/0'],
      ['undo shutdown', 'undo description', 'undo rip split-horizon']],
    [['system-view', 'rip 1'], ['undo summary', 'undo import-route direct']],
    [['system-view', 'aaa'], ['undo local-user alice']],
  ];

  it.each(LEGITIMES)('%j', async (vue, cmds) => {
    for (const c of cmds) {
      const r = await dans(ROUTEUR, vue);
      expect(await r.executeCommand(c), c).not.toMatch(/Unrecognized command/);
    }
  });

  it('sur le switch aussi', async () => {
    for (const [vue, cmds] of [
      [['system-view'], ['undo sysname', 'undo vlan 10']],
      [['system-view', 'interface GigabitEthernet0/0/1'], ['undo shutdown', 'undo description']],
    ] as const) {
      for (const c of cmds) {
        const s = await dans(SWITCH, [...vue]);
        expect(await s.executeCommand(c), c).not.toMatch(/Unrecognized command/);
      }
    }
  });
});

describe('un refus ne defait rien', () => {
  it('la configuration est intacte apres un `undo` refuse', async () => {
    const r = await dans(ROUTEUR, ['system-view', 'sysname LAB',
      'interface GigabitEthernet0/0/0', 'ip address 10.0.12.1 255.255.255.0',
      'description LIEN', 'undo shutdown', 'quit']);
    const avant = await r.executeCommand('display current-configuration');

    for (const mot of INCONNUS) await r.executeCommand(`undo ${mot}`);
    expect(await r.executeCommand('display current-configuration')).toBe(avant);
  });

  it('un `undo` legitime agit toujours apres un refus', async () => {
    const r = await dans(ROUTEUR, ['system-view', 'interface GigabitEthernet0/0/0',
      'description LIEN']);
    expect(await r.executeCommand('display this')).toMatch(/description LIEN/);

    await r.executeCommand('undo zzz');
    await r.executeCommand('undo description');
    expect(await r.executeCommand('display this')).not.toMatch(/description LIEN/);
  });

  it('l\'abreviation vaut aussi derriere `undo`', async () => {
    const r = await dans(ROUTEUR, ['system-view', 'interface GigabitEthernet0/0/0',
      'description LIEN']);
    await r.executeCommand('undo descr');
    expect(await r.executeCommand('display this')).not.toMatch(/description LIEN/);
  });
});

describe('ce que ce lot ne traite pas, et le dit', () => {
  it('un mot en trop derriere une tete valide passe encore', async () => {
    const r = await dans(ROUTEUR, ['system-view']);
    // `Too many parameters` releve du chantier D (lot V4) : la tete est
    // reconnue, donc V1 ne se prononce pas. Le cas est pin ici pour que
    // le jour ou V4 le corrige, il le fasse sciemment.
    expect(await r.executeCommand('undo sysname bbb ccc')).not.toMatch(/Unrecognized command/);
  });
});

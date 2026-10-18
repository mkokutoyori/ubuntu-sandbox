/**
 * Les tableaux de whoami, net user / net localgroup, Format-Table, show
 * mac address-table, show spanning-tree bridge, display vrrp brief et show
 * dmvpn passent par TextTable, et TextTable sait ce qu'il fallait lui
 * ajouter : largeur d'AFFICHAGE (accents combinants, idéogrammes, ANSI),
 * alignement centré, plafond de colonne (troncature, points de
 * suspension, retour à la ligne), caractère de filet, pied de tableau,
 * en-tête sur deux lignes, bloc étiquette/valeur et grille de listes.
 *
 * MESURE DE DEPART (git stash du code source ; _tableAlignment.ts est un
 * outil neuf, il reste en place) : 12 cas sur 14 tombent. Le détecteur de
 * décalage trouvait, sur des transcriptions fraîches, 68 tableaux
 * `show mac address-table` dont l'adresse (17 caractères) débordait un
 * filet de 14, un en-tête de `whoami /user` d'un cran à droite de son
 * filet, `whoami /groups` et `/priv` dont le filet `====` n'avait pas la
 * largeur des données, `show spanning-tree bridge` dont la ligne de
 * données n'avait aucun rapport avec son en-tête, `display vrrp brief`
 * dont `GigabitEthernet0/0/0` (20) débordait une colonne de 17, `show
 * dmvpn` dont l'en-tête et le filet étaient deux chaînes sans lien,
 * `Format-Table` dont l'en-tête des colonnes numériques restait à gauche
 * au-dessus de chiffres calés à droite et dont `-HideTableHeaders`
 * laissait le filet. Les cas VRRP et DMVPN demandent un lab de protocole
 * et ne sont pas rejoués ici ; leurs rendus passent par le même
 * `renderTable`.
 * Passent des deux côtés : le TEMOIN du détecteur (un tableau sain, un
 * tableau fautif écrit à la main) et `net user NAME` (déjà calé sur la
 * colonne 29 : non-régression).
 *
 * Ne sont PAS des défauts, et le détecteur est réglé pour ne pas les
 * signaler : le filet court de `Get-ChildItem` sur le registre (PowerShell
 * souligne l'en-tête, pas la colonne), la ligne « Total number of bindings »
 * qui suit le filet de `show ip dhcp snooping binding`, les colonnes
 * d'Oracle/RMAN dont la sortie réelle déborde elle aussi.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  renderTable, renderKeyValue, renderGrid, columnsFromKeys, displayWidth, padToWidth,
  type TableColumn,
} from '@/network/devices/shells/cli/TextTable';
import { findAlignmentViolations } from './_tableAlignment';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetCounters, MACAddress } from '@/network/core/types';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  EquipmentRegistry.getInstance().clear();
  resetCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

describe('le détecteur lui-même', () => {
  it('TEMOIN: un tableau aligné ne donne rien, un tableau décalé est signalé', () => {
    const sain = 'Name   Id\n----   --\nabc     1\n';
    const fautif = 'Name   Id\n----   --\nabcdef1 1\n';
    expect(findAlignmentViolations(sain)).toEqual([]);
    expect(findAlignmentViolations(fautif).map((v) => v.problem)).toEqual([expect.stringContaining('row crosses')]);
  });
});

describe('TextTable : largeur d\'affichage', () => {
  it('un caractère combinant ne compte pas, un idéogramme vaut deux, une séquence ANSI aucun', () => {
    expect(displayWidth('é')).toBe(1);
    expect(displayWidth('日本')).toBe(4);
    expect(displayWidth('\u001b[31mrouge\u001b[0m')).toBe(5);
    expect(padToWidth('日本', 6)).toBe('日本  ');
  });

  it('une colonne reste alignée avec des accents décomposés et des idéogrammes', () => {
    const rows = [{ n: 'café', v: '1' }, { n: '日本', v: '2' }, { n: 'plain', v: '3' }];
    const lines = renderTable(rows, columnsFromKeys<typeof rows[number]>(['n', 'v']));
    const edges = lines.map((line) => displayWidth(line.slice(0, line.lastIndexOf(' ') + 1)));
    expect(new Set(edges).size).toBe(1);
  });
});

describe('TextTable : colonnes', () => {
  type Row = { name: string; note: string };
  const rows: Row[] = [{ name: 'a', note: 'un texte très long qui dépasse la colonne' }];

  it('center, truncate, ellipsis, wrap', () => {
    const base: TableColumn<Row> = { header: 'Note', width: 10, value: (r) => r.note };
    const only = (column: TableColumn<Row>) => renderTable(rows, [column], { gap: 1, rule: false });
    expect(only({ ...base, overflow: 'truncate' })[1]).toBe('un texte t');
    expect(only({ ...base, overflow: 'ellipsis' })[1]).toBe('un text...');
    expect(only({ ...base, overflow: 'wrap' }).slice(1)).toEqual(['un texte', 'très long', 'qui', 'dépasse la', 'colonne']);
    expect(only({ ...base, overflow: undefined })[1].length).toBeGreaterThan(10);
    expect(renderTable([{ name: 'ab', note: '' }], [{ header: 'Name', width: 8, align: 'center', value: (r) => r.name }],
      { gap: 1, rule: false, padTrailing: true })[1]).toBe('   ab   ');
  });

  it('maxWidth plafonne la largeur automatique ; minWidth la relève', () => {
    const capped = renderTable(rows, [{ header: 'Note', maxWidth: 8, overflow: 'ellipsis', value: (r) => r.note }], { gap: 1, rule: true });
    expect(capped[1]).toBe('--------');
    expect(capped[2]).toBe('un te...');
    const widened = renderTable([{ name: 'a', note: '' }], [{ header: 'N', minWidth: 5, value: (r) => r.name }], { gap: 1, rule: true });
    expect(widened[1]).toBe('-----');
  });

  it('ruleChar, footer, superHeader', () => {
    const lines = renderTable([{ name: 'x', note: '1' }], [
      { header: 'Name', value: (r) => r.name },
      { header: 'N', align: 'right', superHeader: 'Hello', value: (r) => r.note },
    ], { gap: 1, rule: true, ruleChar: '=', footer: [['Total', '1']] });
    expect(lines).toEqual(['      Hello', 'Name      N', '===== =====', 'x         1', 'Total     1']);
  });
});

describe('TextTable : blocs étiquette/valeur et grilles', () => {
  it('renderKeyValue cale les valeurs sur une colonne et replie les valeurs multiples sous elle', () => {
    expect(renderKeyValue([['Host', 'a'], ['Longer label', 'b\nc']], { separator: ' : ' })).toEqual([
      'Host         : a', 'Longer label : b', '               c',
    ]);
  });

  it('renderGrid remplit ligne par ligne ou colonne par colonne', () => {
    const items = ['a', 'bb', 'ccc', 'dd', 'e'];
    expect(renderGrid(items, { columns: 2, cellWidth: 5 })).toEqual(['a    bb', 'ccc  dd', 'e']);
    expect(renderGrid(items, { columns: 2, cellWidth: 5, fill: 'column' })).toEqual(['a    dd', 'bb   e', 'ccc']);
  });
});

describe('les commandes migrées sont alignées', () => {
  const windows = async () => {
    const pc = new WindowsPC('windows-pc', 'WSRV');
    pc.powerOn();
    pc.setCurrentUser('Administrator');
    return pc;
  };

  it('whoami /user, /groups, /priv : filet = largeur des données, colonnes sous leur en-tête', async () => {
    const pc = await windows();
    for (const flag of ['/user', '/groups', '/priv', '/all']) {
      const out = await pc.executeCommand(`whoami ${flag}`);
      expect(findAlignmentViolations(out), flag).toEqual([]);
    }
    const groups = (await pc.executeCommand('whoami /groups')).split('\n');
    const rule = groups.find((l) => l.startsWith('====='))!;
    const widest = Math.max(...groups.slice(groups.indexOf(rule) + 1).map((l) => l.length));
    expect(rule.length).toBeLessThanOrEqual(widest + 40);
    expect(rule.split(' ').every((s) => /^=+$/.test(s))).toBe(true);
  });

  it('net user et net localgroup : trois colonnes de 25, triées, filet de 79', async () => {
    const pc = await windows();
    await pc.executeCommand('net user zoe Passw0rd! /add');
    const list = (await pc.executeCommand('net user')).split('\n');
    expect(list).toContain('-'.repeat(79));
    const names = list.slice(list.indexOf('-'.repeat(79)) + 1, -1).flatMap((l) => l.split(/\s+/).filter(Boolean));
    expect(names).toEqual([...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    expect(list.find((l) => l.startsWith('Administrator'))!.indexOf('alice')).toBe(25);
    const groups = (await pc.executeCommand('net localgroup')).split('\n').filter((l) => l.startsWith('*'));
    expect(groups).toEqual([...groups].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
  });

  it('net user NAME : toutes les valeurs commencent à la colonne 29', async () => {
    const pc = await windows();
    const lines = (await pc.executeCommand('net user Administrator')).split('\n')
      .filter((l) => /^(User name|Full Name|Comment|Account active|Password last set|Last logon|Logon hours allowed)/.test(l));
    expect(lines.length).toBe(7);
    for (const line of lines) expect(line.slice(0, 29).trimEnd().length).toBeLessThanOrEqual(28);
    expect(lines.find((l) => l.startsWith('Account active'))!.slice(29)).toBe('Yes');
  });

  it('Format-Table : en-tête numérique à droite, -HideTableHeaders sans filet', async () => {
    const pc = await windows();
    const shell = PowerShellSubShell.create(pc).subShell;
    const process = (await shell.processLine('Get-Process | Select-Object -First 3 | Format-Table Id, ProcessName')).output.join('\n');
    const [, header, , first] = process.split('\n');
    const idColumnEnd = header.indexOf('Id') + 2;
    expect(first.slice(0, idColumnEnd).trimStart()).toMatch(/^\d+$/);
    const hidden = (await shell.processLine('Get-Service | Select-Object -First 3 | Format-Table Name, Status -HideTableHeaders')).output.join('\n');
    expect(hidden).not.toMatch(/--+/);
    expect(hidden).not.toContain('Name');
    expect(findAlignmentViolations(process)).toEqual([]);
  });

  it('show spanning-tree bridge : en-tête sur deux lignes, données sous leurs colonnes', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    sw.powerOn();
    await sw.executeCommand('enable');
    const out = await sw.executeCommand('show spanning-tree bridge');
    const [top, header, rule, row] = out.split('\n');
    expect(top.trim()).toBe('Hello  Max  Fwd');
    expect(header.indexOf('Time') + 4).toBe(top.indexOf('Hello') + 5);
    expect(row.startsWith('VLAN0001')).toBe(true);
    expect(row.length).toBe(rule.length + 'ieee'.length - 'Protocol'.length);
    expect(findAlignmentViolations(out)).toEqual([]);
  });

  it('show mac address-table : filet = largeur des adresses, Vlan à droite', async () => {
    const sw = new CiscoSwitch('switch-cisco', 'SW1');
    sw.powerOn();
    await sw.executeCommand('enable');
    expect(sw.addStaticMAC('02:00:00:00:00:01', 1, 'FastEthernet0/1')).toBe(true);
    const out = await sw.executeCommand('show mac address-table');
    expect(findAlignmentViolations(out)).toEqual([]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privilegie(): Promise<Cli> {
  const device = nu();
  await device.executeCommand('enable');
  return device;
}

async function avecFiltres(): Promise<Cli> {
  const device = await privilegie();
  await device.executeCommand('configure terminal');
  await device.executeCommand('access-list 10 permit 10.0.0.0 0.0.0.255');
  await device.executeCommand('access-list 20 deny 192.168.0.0 0.0.255.255');
  await device.executeCommand('ip prefix-list LP seq 5 permit 10.0.0.0/8');
  await device.executeCommand('route-map RM permit 10');
  await device.executeCommand('exit');
  await device.executeCommand('ip community-list 1 permit 65001:100');
  await device.executeCommand('ip as-path access-list 1 permit ^65001$');
  await device.executeCommand('end');
  return device;
}

const VUES = [
  'show access-lists',
  'show ip access-lists',
  'show ipv6 access-lists',
  'show ip prefix-list',
  'show ipv6 prefix-list',
  'show route-map',
  'show ip community-list',
  'show ip as-path-access-list',
];

describe('les huit vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('une machine sans filtre rend ce qu\'elle rendait', () => {
  it.each(['show access-lists', 'show ip access-lists', 'show ipv6 access-lists',
    'show ip community-list', 'show ip as-path-access-list'])(
    '`%s` se TAIT', async (command) => {
      expect(await nu().executeCommand(command)).toBe('');
    });

  it('`show ip prefix-list` le dit en toutes lettres', async () => {
    expect(await nu().executeCommand('show ip prefix-list'))
      .toBe('No IP prefix-lists configured.');
  });

  it('`show route-map` de meme', async () => {
    expect(await nu().executeCommand('show route-map'))
      .toBe('No route-maps configured.');
  });
});

describe('les vues lisent le magasin, et l\'argument SELECTIONNE', () => {
  it('`show ip access-lists` rend les deux listes declarees', async () => {
    const rendu = await (await avecFiltres()).executeCommand('show ip access-lists');
    expect(rendu).toContain('Standard IP access list 10');
    expect(rendu).toContain('Standard IP access list 20');
  });

  it('`show ip access-lists 10` n\'en rend qu\'une', async () => {
    const rendu = await (await avecFiltres()).executeCommand('show ip access-lists 10');
    expect(rendu).toContain('Standard IP access list 10');
    expect(rendu).not.toContain('Standard IP access list 20');
  });

  it('`show ip prefix-list` nomme la liste et son entree', async () => {
    const rendu = await (await avecFiltres()).executeCommand('show ip prefix-list');
    expect(rendu).toContain('ip prefix-list LP');
    expect(rendu).toContain('seq 5 permit 10.0.0.0/8');
  });

  it('`show route-map RM` rend la sequence demandee', async () => {
    expect(await (await avecFiltres()).executeCommand('show route-map RM'))
      .toContain('route-map RM, permit sequence 10');
  });

  it('`show ip community-list` rend la liste declarée', async () => {
    expect(await (await avecFiltres()).executeCommand('show ip community-list'))
      .toContain('Community standard list 1');
  });

  it('`show ip as-path-access-list` rend le filtre declaré', async () => {
    const rendu = await (await avecFiltres()).executeCommand('show ip as-path-access-list');
    expect(rendu).toContain('AS path access list 1');
    expect(rendu).toContain('permit ^65001$');
  });
});

describe('`?` decrit la place par ce qu\'il faut y taper', () => {
  const ATTENDU: ReadonlyArray<readonly [string, string]> = [
    ['show ip access-lists ', 'Access list name or number'],
    ['show access-lists ', 'Access list name or number'],
    ['show ipv6 access-lists ', 'Access list name'],
    ['show ip prefix-list ', 'Name of a prefix list'],
    ['show ipv6 prefix-list ', 'Name of a prefix list'],
    ['show route-map ', 'Route map name'],
    ['show ip community-list ', 'Community list name or number'],
    ['show ip as-path-access-list ', 'AS path access list number'],
  ];

  it.each(ATTENDU)('`%s?` annonce « %s »', async (entree, libelle) => {
    expect((await privilegie()).cliHelp(entree)).toContain(libelle);
  });

  it('aucune ne se decrit plus par sa PROPRE description', async () => {
    const device = await privilegie();
    for (const [entree] of ATTENDU) {
      const aide = device.cliHelp(entree);
      expect(aide, entree).not.toMatch(/WORD\s+Display /);
    }
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`show ip prefix-l` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ip prefix-l'))
      .toEqual(['show ip prefix-list']);
  });

  it('`show route-m` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show route-m'))
      .toEqual(['show route-map']);
  });
});

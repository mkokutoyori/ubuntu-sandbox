import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

interface Cli {
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  return device;
}

async function dansOspf(): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', 'router ospf 1']) {
    await device.executeCommand(c);
  }
  return device;
}

describe('l\'arbre du sous-mode `router ospf` est VIDE', () => {
  it('zero chemin', () => {
    const device = nu();
    const shell = (device as unknown as { shell: Record<string, unknown> }).shell;
    expect((shell.configRouterOspfTrie as CommandTrie).enumerateExecutablePaths())
      .toEqual([]);
  });
});

const REGLAGES = [
  'network 10.0.0.0 0.0.0.255 area 0',
  'router-id 1.1.1.1',
  'passive-interface GigabitEthernet0/0',
  'passive-interface default',
  'redistribute static',
  'redistribute static metric 50 metric-type 1 subnets',
  'default-information originate',
  'area 1 stub',
  'maximum-paths 4',
  'max-lsa 12000',
  'default-metric 100',
  'log-adjacency-changes detail',
  'auto-cost reference-bandwidth 1000',
  'timers throttle spf 10 100 1000',
  'summary-address 172.16.0.0 255.255.0.0',
  'distribute-list 1 in',
  'distribute-list prefix FOO in',
  'shutdown',
];

describe('les dix-huit reglages sont acceptes', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await dansOspf()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('chaque negation atteint le gestionnaire de SA commande', () => {
  it.each([
    'no passive-interface GigabitEthernet0/0',
    'no redistribute static',
    'no default-information originate',
    'no area 1 stub',
    'no shutdown',
    'no distribute-list 1 in',
  ])('`%s`', async (commande) => {
    const device = await dansOspf();
    await device.executeCommand(commande.slice(3));
    expect(await device.executeCommand(commande)).not.toContain('Invalid input');
  });

  it('`no passive-interface` rend vraiment l\'interface active', async () => {
    const device = await dansOspf();
    await device.executeCommand('passive-interface GigabitEthernet0/0');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('passive-interface GigabitEthernet0/0');

    await device.executeCommand('configure terminal');
    await device.executeCommand('router ospf 1');
    await device.executeCommand('no passive-interface GigabitEthernet0/0');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .not.toContain('passive-interface GigabitEthernet0/0');
  });
});

describe('`network` prend son aire APRES ses deux adresses', () => {
  it('`network ?` annonce le reseau, pas le mot `area`', async () => {
    const aide = (await dansOspf()).cliHelp('network ');
    expect(aide).toContain('Network number');
    expect(aide).not.toContain('area');
  });

  it('`network <reseau> <masque> ?` annonce `area`', async () => {
    expect((await dansOspf()).cliHelp('network 10.0.0.0 0.0.0.255 '))
      .toContain('area');
  });

  it('un troisieme mot qui n\'est pas `area` est refuse au caret', async () => {
    expect(await (await dansOspf()).executeCommand('network 10.0.0.0 0.0.0.255 0'))
      .toContain('Invalid input detected');
  });

  it('la ligne complete ressort dans la configuration', async () => {
    const device = await dansOspf();
    await device.executeCommand('network 10.0.0.0 0.0.0.255 area 0');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('network 10.0.0.0 0.0.0.255 area 0');
  });
});

describe('`?` annonce la place, et garde son nom a chaque noeud', () => {
  const ATTENDU: ReadonlyArray<readonly [string, string]> = [
    ['router-id ', 'OSPF router-id in IP address format'],
    ['maximum-paths ', '<1-32>'],
    ['max-lsa ', '<1-4294967294>'],
    ['default-metric ', '<1-16777214>'],
    ['redistribute ', 'Static routes'],
    ['distribute-list ', '<1-199>'],
    ['passive-interface ', 'Interface on which updates are suppressed'],
  ];

  it.each(ATTENDU)('`%s?` annonce %s', async (entree, attendu) => {
    expect((await dansOspf()).cliHelp(entree)).toContain(attendu);
  });

  it('les noeuds intermediaires gardent leur propre nom', async () => {
    const aide = (await dansOspf()).cliHelp('');
    for (const attendu of ['Control distribution of default information',
      'Advertise the maximum metric', 'Protocol timers', 'Protocol version']) {
      expect(aide, attendu).toContain(attendu);
    }
  });

  it('`timers ?` decrit ses trois familles', async () => {
    const aide = (await dansOspf()).cliHelp('timers ');
    expect(aide).toContain('Link State Advertisement');
    expect(aide).toContain('Pacing');
    expect(aide).toContain('Throttle timers');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`router-i` se complete', async () => {
    expect((await dansOspf()).cliTabCandidates('router-i'))
      .toEqual(['router-id']);
  });

  it('`network 10.0.0.0 0.0.0.255 ar` garde les adresses deja tapees', async () => {
    expect((await dansOspf()).cliTabCandidates('network 10.0.0.0 0.0.0.255 ar'))
      .toEqual(['network 10.0.0.0 0.0.0.255 area']);
  });
});

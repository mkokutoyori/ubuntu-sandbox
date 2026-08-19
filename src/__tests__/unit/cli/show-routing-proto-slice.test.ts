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

async function avecBgp(): Promise<Cli> {
  const device = await privilegie();
  await device.executeCommand('configure terminal');
  await device.executeCommand('router bgp 65001');
  await device.executeCommand('neighbor 10.0.0.2 remote-as 65002');
  await device.executeCommand('end');
  return device;
}

async function avecEigrp(): Promise<Cli> {
  const device = await privilegie();
  await device.executeCommand('configure terminal');
  await device.executeCommand('router eigrp 100');
  await device.executeCommand('network 10.0.0.0');
  await device.executeCommand('end');
  return device;
}

const VUES = [
  'show ip bgp',
  'show ip bgp summary',
  'show ip bgp neighbors',
  'show bgp',
  'show ip eigrp traffic',
  'show ip eigrp accounting',
  'show ip eigrp neighbors',
  'show ip eigrp topology',
  'show ip eigrp interfaces',
  'show eigrp protocols',
  'show eigrp address-family ipv4 neighbors',
  'show ip protocols',
];

describe('les douze vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('une machine sans protocole rend ce qu\'elle rendait', () => {
  it.each(['show ip bgp', 'show ip bgp summary', 'show bgp'])(
    '`%s` annonce que BGP n\'est pas actif', async (command) => {
      expect(await nu().executeCommand(command)).toBe('% BGP not active');
    });

  it.each(['show ip eigrp traffic', 'show ip eigrp neighbors', 'show eigrp protocols'])(
    '`%s` se TAIT plutot que de decrire un processus absent', async (command) => {
      expect(await nu().executeCommand(command)).toBe('');
    });

  it('`show ip protocols` le dit en toutes lettres', async () => {
    expect(await nu().executeCommand('show ip protocols'))
      .toBe('No routing protocol is configured.');
  });
});

describe('les vues lisent le moteur, pas la seule configuration', () => {
  it('`show ip bgp summary` nomme l\'AS local et le voisin declare', async () => {
    const sortie = await (await avecBgp()).executeCommand('show ip bgp summary');
    expect(sortie).toContain('local AS number 65001');
    expect(sortie).toContain('10.0.0.2');
  });

  it('`show ip bgp neighbors` refuse un voisin qui n\'existe pas', async () => {
    expect(await (await avecBgp()).executeCommand('show ip bgp neighbors 10.9.9.9'))
      .toBe('% No such neighbor or address family');
  });

  it('`show ip bgp <prefixe>` absent de la table le dit', async () => {
    expect(await (await avecBgp()).executeCommand('show ip bgp 192.0.2.0'))
      .toBe('% Network not in table');
  });

  it('`show ip eigrp traffic` compte pour l\'AS configure', async () => {
    expect(await (await avecEigrp()).executeCommand('show ip eigrp traffic'))
      .toContain('IP-EIGRP Traffic Statistics for AS 100');
  });

  it('`show eigrp protocols` lit le MEME moteur que la syntaxe classique',
    async () => {
      const device = await avecEigrp();
      const nomme = await device.executeCommand('show eigrp protocols');
      const classique = await device.executeCommand('show ip protocols');
      expect(nomme).toContain('EIGRP-IPv4 Protocol for AS(100)');
      expect(classique).toContain('eigrp 100');
    });
});

describe('l\'argument est ANNONCE la ou la commande en lit un', () => {
  it('`show ip bgp ?` annonce le prefixe, comme IOS', async () => {
    const aide = (await privilegie()).cliHelp('show ip bgp ');
    expect(aide).toContain('A.B.C.D');
    expect(aide).toContain('Network in the BGP routing table to display');
  });

  it('`show ip bgp neighbors ?` annonce l\'adresse du voisin', async () => {
    expect((await privilegie()).cliHelp('show ip bgp neighbors '))
      .toContain('Neighbor to display information about');
  });

  it('`show ip eigrp interfaces ?` annonce l\'interface', async () => {
    expect((await privilegie()).cliHelp('show ip eigrp interfaces '))
      .toContain('Interface name');
  });

  it('une place que le gestionnaire ne lit pas n\'est PAS annoncee', async () => {
    const aide = (await privilegie()).cliHelp('show ip eigrp neighbors ');
    expect(aide).toContain('detail');
    expect(aide).not.toContain('LINE');
    expect(aide).not.toContain('WORD');
  });
});

describe('un noeud de branche n\'est plus decrit par la configuration', () => {
  it('`show eigrp ?` ne parle plus d\'ENTRER dans une famille d\'adresses',
    async () => {
      const aide = (await privilegie()).cliHelp('show eigrp ');
      expect(aide).toContain('address-family');
      expect(aide).not.toContain('Enter address family configuration');
    });

  it('`show eigrp address-family ?` decrit une vue et non un mode', async () => {
    const aide = (await privilegie()).cliHelp('show eigrp address-family ');
    expect(aide).toContain('ipv4');
    expect(aide).not.toContain('IPv4 configuration');
  });
});

describe('les continuations declarees restent executables', () => {
  it.each([
    ['show ip eigrp neighbors detail', 'detail'],
    ['show ip eigrp topology all-links', 'all-links'],
    ['show ip eigrp interfaces detail', 'detail'],
  ])('`%s` est acceptee', async (command) => {
    expect(await (await avecEigrp()).executeCommand(command))
      .not.toContain('Invalid input');
  });

  it('`show ip protocols vrf` sans nom reste incomplete', async () => {
    expect(await (await privilegie()).executeCommand('show ip protocols vrf'))
      .toContain('% Incomplete command.');
  });

  it('`show ip protocols vrf <inconnue>` nomme la VRF absente', async () => {
    expect(await (await privilegie()).executeCommand('show ip protocols vrf ZORG'))
      .toBe('% VRF ZORG does not exist');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`show ip eigrp nei` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ip eigrp nei'))
      .toEqual(['show ip eigrp neighbors']);
  });

  it('`show ip bgp sum` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ip bgp sum'))
      .toEqual(['show ip bgp summary']);
  });
});

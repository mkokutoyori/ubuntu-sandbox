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

async function avecMulticast(): Promise<Cli> {
  const device = await privilegie();
  await device.executeCommand('configure terminal');
  await device.executeCommand('ip multicast-routing');
  await device.executeCommand('interface GigabitEthernet0/0');
  await device.executeCommand('ip address 10.0.0.1 255.255.255.0');
  await device.executeCommand('ip pim sparse-mode');
  await device.executeCommand('no shutdown');
  await device.executeCommand('end');
  return device;
}

const VUES = [
  'show ip pim neighbor',
  'show ip pim rp mapping',
  'show ip pim bsr-router',
  'show ip pim interface',
  'show ip mroute',
  'show ip igmp groups',
  'show ip igmp interface',
];

describe('les sept vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('une machine sans multicast rend ce qu\'elle rendait', () => {
  it('`show ip pim neighbor` rend son en-tete et aucune ligne', async () => {
    expect(await nu().executeCommand('show ip pim neighbor'))
      .toBe('PIM Neighbor Table\n'
        + 'Neighbor Address  Interface                Uptime/Expires    Ver  DR Prio/Mode');
  });

  it('`show ip pim rp mapping` dit que la machine n\'est pas RP', async () => {
    expect(await nu().executeCommand('show ip pim rp mapping'))
      .toContain('This system is not a PIM RP.');
  });

  it('`show ip pim bsr-router` dit qu\'elle n\'est dans aucun domaine', async () => {
    expect(await nu().executeCommand('show ip pim bsr-router'))
      .toContain('This system is not part of any PIM domain.');
  });

  it('`show ip igmp interface` se TAIT', async () => {
    expect(await nu().executeCommand('show ip igmp interface')).toBe('');
  });
});

describe('`?` n\'annonce plus une option que rien n\'applique', () => {
  it('`show ip pim neighbor ?` ne propose plus `count` ni `detail`', async () => {
    const aide = (await privilegie()).cliHelp('show ip pim neighbor ');
    expect(aide).not.toContain('count');
    expect(aide).not.toContain('detail');
  });

  it('`show ip pim interface ?` ne propose plus `count`', async () => {
    expect((await privilegie()).cliHelp('show ip pim interface '))
      .not.toContain('count');
  });

  it('les deux annoncent l\'interface, qui est ce qu\'elles LISENT', async () => {
    const device = await privilegie();
    expect(device.cliHelp('show ip pim neighbor ')).toContain('Interface name');
    expect(device.cliHelp('show ip pim interface ')).toContain('Interface name');
  });
});

describe('`?` decrit la place par ce qu\'il faut y taper', () => {
  it('`show ip mroute ?` annonce une adresse de groupe', async () => {
    const aide = (await privilegie()).cliHelp('show ip mroute ');
    expect(aide).toContain('A.B.C.D');
    expect(aide).not.toContain('Display IP multicast routing table\n');
  });

  it('`show ip igmp interface ?` annonce une interface', async () => {
    expect((await privilegie()).cliHelp('show ip igmp interface '))
      .toContain('Interface name');
  });

  it('`show ip igmp groups ?` garde `detail`, qui est implemente', async () => {
    expect((await privilegie()).cliHelp('show ip igmp groups ')).toContain('detail');
  });
});

describe('un noeud de branche n\'est plus decrit par le vide', () => {
  it('`show ip pim ?` decrit `rp`', async () => {
    const ligne = (await privilegie()).cliHelp('show ip pim ')
      .split('\n').find((l) => l.trim().startsWith('rp'))!;
    expect(ligne).toBeDefined();
    expect(ligne.replace(/^\s*rp\s*/, '').trim().length).toBeGreaterThan(0);
  });
});

describe('un nom d\'interface abrege designe la meme interface', () => {
  it('`show ip pim interface Gi0/0` decrit la meme chose que le nom entier',
    async () => {
      const device = await avecMulticast();
      const entier = await device.executeCommand(
        'show ip pim interface GigabitEthernet0/0');
      const abrege = await device.executeCommand('show ip pim interface Gi0/0');
      expect(abrege).toBe(entier);
      expect(entier).toContain('GigabitEthernet0/0');
    });

  it('`show ip igmp interface Gi0/0` de meme', async () => {
    const device = await avecMulticast();
    const entier = await device.executeCommand(
      'show ip igmp interface GigabitEthernet0/0');
    const abrege = await device.executeCommand('show ip igmp interface Gi0/0');
    expect(abrege).toBe(entier);
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`show ip pim nei` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ip pim nei'))
      .toEqual(['show ip pim neighbor']);
  });

  it('`show ip igmp gro` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ip igmp gro'))
      .toEqual(['show ip igmp groups']);
  });
});

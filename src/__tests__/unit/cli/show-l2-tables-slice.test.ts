import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  const device = new CiscoSwitch(
    'switch-cisco', `SW${serial++}`, 24, 0, 0) as unknown as Cli;
  device.powerOn();
  return device;
}

async function privilegie(): Promise<Cli> {
  const device = nu();
  await device.executeCommand('enable');
  return device;
}

const VUES = [
  'show mac address-table',
  'show mac address-table count',
  'show mac address-table aging-time',
  'show ip arp inspection',
  'show ip arp inspection statistics',
  'show ip arp inspection log',
  'show ip arp inspection interfaces',
  'show arp access-list',
  'show errdisable recovery',
  'show ip device tracking',
  'show dtp',
];

describe('les onze vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('les deux effacements restent PRIVILEGIES', () => {
  it.each(['clear mac address-table', 'clear ip arp inspection statistics'])(
    '`%s` est refusee sans `enable`', async (command) => {
      expect(await nu().executeCommand(command)).toContain('% Invalid input');
    });

  it.each(['clear mac address-table', 'clear ip arp inspection statistics'])(
    '`%s` est acceptee en EXEC privilegie', async (command) => {
      expect(await (await privilegie()).executeCommand(command)).toBe('');
    });
});

describe('les vues lisent les tables du commutateur', () => {
  it('`show mac address-table` rend son en-tete', async () => {
    expect(await (await privilegie()).executeCommand('show mac address-table'))
      .toContain('Mac Address Table');
  });

  it('`show mac address-table count` compte au lieu de lister', async () => {
    const rendu = await (await privilegie()).executeCommand('show mac address-table count');
    expect(rendu).toContain('Mac Address Count');
    expect(rendu).toContain('Total Mac Addresses for this criterion');
  });

  it('`show ip arp inspection` decrit l\'etat du controle', async () => {
    expect(await (await privilegie()).executeCommand('show ip arp inspection'))
      .not.toBe('');
  });
});

describe('`?` garde les filtres declares, et decrit les places', () => {
  it('`show mac address-table ?` propose ses sept filtres', async () => {
    const aide = (await privilegie()).cliHelp('show mac address-table ');
    for (const mot of ['address', 'count', 'dynamic', 'interface',
      'multicast', 'static', 'vlan']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`clear mac address-table ?` propose ses trois filtres', async () => {
    const aide = (await privilegie()).cliHelp('clear mac address-table ');
    for (const mot of ['dynamic', 'interface', 'vlan']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`show dtp ?` propose `interface`', async () => {
    expect((await privilegie()).cliHelp('show dtp ')).toContain('interface');
  });

  it('`show ip arp inspection vlan ?` annonce la plage', async () => {
    const aide = (await privilegie()).cliHelp('show ip arp inspection vlan ');
    expect(aide).toContain('<1-4094>');
    expect(aide).not.toContain('Display DAI per VLAN');
  });

  it('`show ip device tracking ?` decrit ce que la place accepte', async () => {
    const aide = (await privilegie()).cliHelp('show ip device tracking ');
    expect(aide).toContain('Interface name, or an address');
    expect(aide).not.toContain('Display IP device tracking table');
  });
});

describe('les filtres declares sont executables', () => {
  it.each([
    'show mac address-table dynamic',
    'show mac address-table static',
    'show mac address-table vlan 1',
    'clear mac address-table dynamic',
  ])('`%s` est acceptee', async (command) => {
    expect(await (await privilegie()).executeCommand(command))
      .not.toContain('Invalid input');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`show mac address-table cou` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show mac address-table cou'))
      .toEqual(['show mac address-table count']);
  });

  it('`show ip arp inspection stat` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ip arp inspection stat'))
      .toEqual(['show ip arp inspection statistics']);
  });
});

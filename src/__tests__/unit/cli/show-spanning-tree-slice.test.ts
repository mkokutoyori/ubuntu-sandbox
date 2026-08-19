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
  'show spanning-tree',
  'show spanning-tree summary',
  'show spanning-tree summary totals',
  'show spanning-tree detail',
  'show spanning-tree root',
  'show spanning-tree bridge',
  'show spanning-tree blockedports',
  'show spanning-tree active',
  'show spanning-tree inconsistentports',
  'show spanning-tree pathcost method',
  'show spanning-tree mst',
  'show spanning-tree mst configuration',
];

describe('les douze vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('les vues lisent l\'agent STP', () => {
  it('`show spanning-tree` nomme le VLAN et son protocole', async () => {
    const rendu = await (await privilegie()).executeCommand('show spanning-tree');
    expect(rendu).toContain('VLAN0001');
    expect(rendu).toContain('Spanning tree enabled protocol');
  });

  it('`show spanning-tree pathcost method` nomme la methode', async () => {
    expect(await (await privilegie()).executeCommand('show spanning-tree pathcost method'))
      .toContain('Spanning tree default pathcost method used is');
  });

  it('`show spanning-tree mst configuration` rend la region', async () => {
    expect(await (await privilegie()).executeCommand('show spanning-tree mst configuration'))
      .not.toContain('Invalid input');
  });
});

describe('`show spanning-tree vlan` prend son numero AVANT ses trois vues', () => {
  it('`show spanning-tree vlan ?` annonce la plage de VLAN', async () => {
    const aide = (await privilegie()).cliHelp('show spanning-tree vlan ');
    expect(aide).toContain('<1-4094>');
    expect(aide).not.toContain('bridge');
  });

  it('`show spanning-tree vlan 1 ?` annonce les trois vues', async () => {
    const aide = (await privilegie()).cliHelp('show spanning-tree vlan 1 ');
    expect(aide).toContain('bridge');
    expect(aide).toContain('detail');
    expect(aide).toContain('root');
  });

  it('sans numero, la vue est refusee au caret', async () => {
    expect(await (await privilegie()).executeCommand('show spanning-tree vlan detail'))
      .toContain('% Invalid input');
  });

  it.each(['detail', 'root', 'bridge'])(
    '`show spanning-tree vlan 1 %s` est acceptee', async (vue) => {
      expect(await (await privilegie()).executeCommand(`show spanning-tree vlan 1 ${vue}`))
        .not.toContain('Invalid input');
    });

  it('la tabulation garde le numero deja tape', async () => {
    expect((await privilegie()).cliTabCandidates('show spanning-tree vlan 1 det'))
      .toEqual(['show spanning-tree vlan 1 detail']);
  });
});

describe('`?` decrit la place par ce qu\'il faut y taper', () => {
  it('`show spanning-tree interface ?` annonce l\'interface', async () => {
    const aide = (await privilegie()).cliHelp('show spanning-tree interface ');
    expect(aide).toContain('Interface name');
    expect(aide).not.toContain('STP for an interface');
  });

  it('`show spanning-tree mst ?` annonce l\'instance', async () => {
    expect((await privilegie()).cliHelp('show spanning-tree mst ')).toContain('<0-4094>');
  });

  it('`show spanning-tree ?` garde le nom propre de `pathcost`', async () => {
    const ligne = (await privilegie()).cliHelp('show spanning-tree ')
      .split('\n').find((l) => l.trim().startsWith('pathcost'))!;
    expect(ligne).toContain('Path cost method');
  });
});

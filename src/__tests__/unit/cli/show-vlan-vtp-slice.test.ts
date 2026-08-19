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

async function avecVlans(): Promise<Cli> {
  const device = await privilegie();
  await device.executeCommand('configure terminal');
  await device.executeCommand('vlan 10');
  await device.executeCommand('name COMPTA');
  await device.executeCommand('exit');
  await device.executeCommand('vtp domain LAB');
  await device.executeCommand('end');
  return device;
}

const VUES = [
  'show vlan', 'show vlan brief', 'show vlan summary',
  'show vtp status', 'show vtp counters', 'show vtp devices', 'show vtp password',
];

describe('les sept vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });

  it('`vtp primary` reste PRIVILEGIEE', async () => {
    expect(await nu().executeCommand('vtp primary')).toContain('% Invalid input');
  });
});

describe('les vues lisent la base de VLAN et le magasin VTP', () => {
  it('`show vlan` liste le VLAN declare avec son nom', async () => {
    const rendu = await (await avecVlans()).executeCommand('show vlan');
    expect(rendu).toContain('COMPTA');
    expect(rendu).toContain('10');
  });

  it('`show vlan id 10` ne rend que celui-la', async () => {
    const rendu = await (await avecVlans()).executeCommand('show vlan id 10');
    expect(rendu).toContain('COMPTA');
    expect(rendu).not.toContain('default');
  });

  it('`show vlan name COMPTA` le retrouve par son nom', async () => {
    expect(await (await avecVlans()).executeCommand('show vlan name COMPTA'))
      .toContain('COMPTA');
  });

  it('`show vlan summary` compte ce que la base porte', async () => {
    expect(await (await avecVlans()).executeCommand('show vlan summary'))
      .toContain('Number of existing VLANs          : 2');
  });

  it('`show vtp status` nomme le domaine configure', async () => {
    expect(await (await avecVlans()).executeCommand('show vtp status')).toContain('LAB');
  });

  it('`show vtp password` dit son absence plutot que de se taire', async () => {
    expect(await (await privilegie()).executeCommand('show vtp password'))
      .toBe('The VTP password is not configured.');
  });
});

describe('`?` decrit la place par ce qu\'il faut y taper', () => {
  it('`show vlan id ?` annonce la plage', async () => {
    const aide = (await privilegie()).cliHelp('show vlan id ');
    expect(aide).toContain('<1-4094>');
    expect(aide).not.toContain('Display a VLAN by id');
  });

  it('`show vlan name ?` annonce le nom', async () => {
    const aide = (await privilegie()).cliHelp('show vlan name ');
    expect(aide).toContain('VLAN name');
    expect(aide).not.toContain('Display a VLAN by name');
  });

  it('`show vlan ?` garde ses quatre sous-vues et `<cr>`', async () => {
    const aide = (await privilegie()).cliHelp('show vlan ');
    for (const mot of ['brief', 'id', 'name', 'summary', '<cr>']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`vtp ?` propose `primary` en EXEC privilegie', async () => {
    expect((await privilegie()).cliHelp('vtp ')).toContain('primary');
  });

  it('`vtp primary ?` annonce `force`', async () => {
    expect((await privilegie()).cliHelp('vtp primary ')).toContain('force');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`show vtp stat` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show vtp stat'))
      .toEqual(['show vtp status']);
  });

  it('`show vlan sum` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show vlan sum'))
      .toEqual(['show vlan summary']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

interface Fw {
  executeCommand(command: string): Promise<string>;
  getIsPoweredOn(): boolean;
  getHostname(): string;
  powerOn(): void;
}

function fortigate(): Fw {
  const fw = createDevice('firewall-fortinet', 0, 0) as unknown as Fw;
  if (!fw.getIsPoweredOn()) fw.powerOn();
  return fw;
}

async function taper(fw: Fw, lignes: readonly string[]): Promise<void> {
  for (const ligne of lignes) await fw.executeCommand(ligne);
}

describe('`execute shutdown` eteint pour de bon', () => {
  it('l appareil n est plus alimente', async () => {
    const fw = fortigate();
    await fw.executeCommand('execute shutdown');

    expect(fw.getIsPoweredOn()).toBe(false);
  });

  it('et la commande ANNONCE ce qu elle fait', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('execute shutdown'))
      .toMatch(/This operation will shutdown the system/);
  });
});

describe('`execute reboot` redemarre pour de bon', () => {
  it('l appareil reste alimente apres le redemarrage', async () => {
    const fw = fortigate();
    await fw.executeCommand('execute reboot');

    expect(fw.getIsPoweredOn()).toBe(true);
  });

  it('et la commande ANNONCE ce qu elle fait', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('execute reboot'))
      .toMatch(/This operation will reboot the system/);
  });

  it('le redemarrage garde la configuration commitee', async () => {
    const fw = fortigate();
    await taper(fw, ['config system global', 'set hostname GARDE', 'end']);
    await fw.executeCommand('execute reboot');

    expect(fw.getHostname()).toBe('GARDE');
  });
});

describe('`execute factoryreset` remet la configuration d usine', () => {
  it('le nom d hote configure disparait', async () => {
    const fw = fortigate();
    const usine = fw.getHostname();
    await taper(fw, ['config system global', 'set hostname EPHEMERE', 'end']);
    await fw.executeCommand('execute factoryreset');

    expect(fw.getHostname()).not.toBe('EPHEMERE');
    expect(fw.getHostname()).toBe(usine);
  });

  it('et la commande ANNONCE ce qu elle fait', async () => {
    const fw = fortigate();

    expect(await fw.executeCommand('execute factoryreset'))
      .toMatch(/This operation will reset the system to factory default/);
  });

  it('une politique creee ne survit pas', async () => {
    const fw = fortigate();
    await taper(fw, [
      'config firewall policy', 'edit 1',
      'set srcintf "port1"', 'set dstintf "wan1"',
      'set srcaddr "all"', 'set dstaddr "all"', 'set service "ALL"',
      'next', 'end',
    ]);
    await fw.executeCommand('execute factoryreset');

    expect(await fw.executeCommand('show firewall policy')).not.toMatch(/edit 1/);
  });

  it('l appareil reste alimente', async () => {
    const fw = fortigate();
    await fw.executeCommand('execute factoryreset');

    expect(fw.getIsPoweredOn()).toBe(true);
  });
});

describe('l annonce est celle du constructeur, mot pour mot', () => {
  const ATTENDU: ReadonlyArray<[string, string]> = [
    ['execute reboot', 'This operation will reboot the system !'],
    ['execute shutdown', 'This operation will shutdown the system !'],
    ['execute factoryreset', 'This operation will reset the system to factory default!'],
  ];

  for (const [commande, annonce] of ATTENDU) {
    it(`\`${commande}\``, async () => {
      const fw = fortigate();

      expect((await fw.executeCommand(commande)).split('\n')[0]).toBe(annonce);
    });
  }
});

describe('un appareil ETEINT ne repond plus', () => {
  it('apres `execute shutdown`, une commande ne rend rien d utile', async () => {
    const fw = fortigate();
    await fw.executeCommand('execute shutdown');

    expect(fw.getIsPoweredOn()).toBe(false);
  });
});

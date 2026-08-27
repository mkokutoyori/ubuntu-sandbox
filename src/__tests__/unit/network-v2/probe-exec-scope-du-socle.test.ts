import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
  EquipmentRegistry.resetInstance();
});

function catalyst(): { executeCommand(c: string): Promise<string> } {
  const sw = new CiscoSwitch('switch-cisco', 'SW', 8, 0, 0);
  sw.powerOn();
  return sw as unknown as { executeCommand(c: string): Promise<string> };
}

const AVANT_ENABLE = [
  'show monitor',
  'show monitor session 1',
  'show udld',
  'show dot1x',
  'show lacp sys-id',
  'show pagp',
  'show ip arp inspection',
];

describe('une vue de l EXEC utilisateur repond AVANT enable', () => {
  for (const vue of AVANT_ENABLE) {
    it(`\`${vue}\``, async () => {
      expect(await catalyst().executeCommand(vue)).not.toMatch(/Invalid input/);
    });
  }
});

describe('et le meme constructeur garde ses commandes de configuration au niveau 15', () => {
  it('`udld port` reste refuse avant enable', async () => {
    const sw = catalyst();

    expect(await sw.executeCommand('udld port'))
      .toMatch(/Unknown command or computer name/);
  });

  it('`dot1x system-auth-control` reste refuse avant enable', async () => {
    const sw = catalyst();

    expect(await sw.executeCommand('dot1x system-auth-control'))
      .toMatch(/Unknown command or computer name/);
  });

  it('mais il est accepte en configuration', async () => {
    const sw = catalyst();
    await sw.executeCommand('enable');
    await sw.executeCommand('configure terminal');

    expect(await sw.executeCommand('dot1x system-auth-control')).not.toMatch(/Invalid input/);
  });
});

describe('la vue rend la MEME chose dans les deux portees', () => {
  for (const vue of ['show udld', 'show monitor', 'show dot1x']) {
    it(`\`${vue}\``, async () => {
      const utilisateur = await catalyst().executeCommand(vue);
      const sw = catalyst();
      await sw.executeCommand('enable');

      expect(await sw.executeCommand(vue)).toBe(utilisateur);
    });
  }
});

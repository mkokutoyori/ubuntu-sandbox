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
}

let serial = 0;

async function enConfiguration(...lines: string[]): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`) as unknown as Cli;
  await device.executeCommand('enable');
  await device.executeCommand('configure terminal');
  for (const l of lines) await device.executeCommand(l);
  return device;
}

async function runningConfig(device: Cli): Promise<string[]> {
  await device.executeCommand('end');
  return (await device.executeCommand('show running-config')).split('\n').map(l => l.trim());
}

describe('les reglages GLOBAUX sortent dans la configuration', () => {
  it.each([
    'radius-server key GLOBALE',
    'radius-server timeout 12',
    'radius-server retransmit 7',
    'tacacs-server key GLOBALE',
    'tacacs-server timeout 12',
  ])('`%s` est reproduite', async (commande) => {
    const device = await enConfiguration(commande);

    expect(await runningConfig(device)).toContain(commande);
  });

  it('et une machine qui les REJOUE les retrouve', async () => {
    const source = await enConfiguration(
      'radius-server key GLOBALE',
      'radius-server timeout 12',
      'tacacs-server key AUTRE',
    );
    const lignes = (await runningConfig(source))
      .filter(l => l.startsWith('radius-server') || l.startsWith('tacacs-server'));

    const cible = await enConfiguration(...lignes);

    expect((await runningConfig(cible))
      .filter(l => l.startsWith('radius-server') || l.startsWith('tacacs-server')))
      .toEqual(lignes);
  });

  it('une valeur qui n\'est pas un nombre est refusee, pas rangee', async () => {
    const device = await enConfiguration();

    expect(await device.executeCommand('radius-server timeout toto')).toContain('Invalid input');
    expect(await device.executeCommand('tacacs-server timeout toto')).toContain('Invalid input');
  });
});

describe('un hote SANS valeur propre prend la valeur globale', () => {
  it('le delai global vaut pour un hote qui n\'en declare pas', async () => {
    const device = await enConfiguration(
      'radius-server host 10.0.0.1 key SECRET',
      'radius-server timeout 12',
    );

    const lignes = await runningConfig(device);

    expect(lignes).toContain('radius-server timeout 12');
    expect(lignes.find(l => l.startsWith('radius-server host'))).not.toContain('timeout');
  });

  it('et un hote qui declare le sien le garde — le temoin', async () => {
    const device = await enConfiguration(
      'tacacs-server host 10.0.0.2 timeout 30 key SECRET',
      'tacacs-server timeout 12',
    );

    const lignes = await runningConfig(device);

    expect(lignes).toContain('tacacs-server timeout 12');
    expect(lignes.find(l => l.startsWith('tacacs-server host'))).toContain('timeout 30');
  });
});

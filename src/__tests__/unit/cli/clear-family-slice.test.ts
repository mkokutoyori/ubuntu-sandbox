import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { createDevice, resetDeviceCounters } from '@/network/devices/DeviceFactory';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  EquipmentRegistry.resetInstance();
});

type Cli = { cliHelp(input: string): string; executeCommand(line: string): Promise<string> };

let serial = 0;

function freshRouter(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privileged(): Promise<Cli> {
  const device = freshRouter();
  await device.executeCommand('enable');
  return device;
}

describe('les niveaux sont ceux d\'avant la migration, mesures un par un', () => {
  it.each(['clear history', 'clear host toto'])(
    '`%s` reste accessible en EXEC utilisateur', async (command) => {
      expect(await freshRouter().executeCommand(command)).not.toContain('Invalid input');
    });

  it.each(['clear arp-cache', 'clear ipv6 neighbors', 'clear ipv6 traffic'])(
    '`%s` reste refusee en EXEC utilisateur', async (command) => {
      expect(await freshRouter().executeCommand(command)).toContain('Invalid input');
    });

  it.each(['clear arp-cache', 'clear ipv6 neighbors', 'clear ipv6 traffic'])(
    'et acceptee en EXEC privilegie — `%s`', async (command) => {
      expect(await (await privileged()).executeCommand(command)).toBe('');
    });
});

describe('elles effacent pour de bon, elles ne font pas qu\'analyser', () => {
  it('`clear host <nom>` retire l\'entree de la table', async () => {
    const device = await privileged();
    await device.executeCommand('configure terminal');
    await device.executeCommand('ip host serveur 10.0.0.9');
    await device.executeCommand('end');

    expect(await device.executeCommand('show hosts')).toContain('serveur');

    await device.executeCommand('clear host serveur');

    expect(await device.executeCommand('show hosts')).not.toContain('serveur');
  });

  it('`clear history` vide le tampon des commandes', async () => {
    const device = await privileged();
    await device.executeCommand('show version');
    await device.executeCommand('show clock');

    expect((await device.executeCommand('show history')).split('\n').length)
      .toBeGreaterThan(2);

    await device.executeCommand('clear history');

    expect((await device.executeCommand('show history')).split('\n').length)
      .toBeLessThan(3);
  });
});

describe('un mot en trop est refuse, pas avale', () => {
  it.each(['clear arp-cache zorglub', 'clear history zorglub'])(
    '`%s` recoit le caret', async (command) => {
      expect(await (await privileged()).executeCommand(command)).toContain('Invalid input');
    });

  it('`clear host` sans nom est incomplete', async () => {
    expect(await (await privileged()).executeCommand('clear host')).toContain('Incomplete');
  });
});

describe('un prefixe que la SUITE tranche n\'est pas ambigu', () => {
  // `cl` designe `clear` ET `clock`. Le trie tranchait deja par le mot
  // suivant — c'est la regle d'IOS — et le socle ne le faisait pas :
  // migrer `clear arp-cache` suffisait donc a faire refuser `cl arp`,
  // une frappe que ce depot teste depuis longtemps.
  it.each(['cl arp', 'cl arp-cache', 'cl hist'])(
    '`%s` designe `clear`, la seule branche qui accepte la suite', async (command) => {
      expect(await (await privileged()).executeCommand(command)).toBe('');
    });

  it('et `cl` SEUL reste ambigu — rien ne le tranche', async () => {
    const out = await (await privileged()).executeCommand('cl');

    expect(out).not.toBe('');
  });

  it('`clo set` designe `clock`, l\'autre branche — le temoin', async () => {
    const device = await privileged();

    expect(await device.executeCommand('clo set 10:00:00 1 January 2026'))
      .not.toContain('Invalid input');
  });
});

describe('le commutateur garde ce qu\'il avait, et rien de plus', () => {
  async function switchDevice(): Promise<Cli> {
    const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
    await device.executeCommand('enable');
    return device;
  }

  it.each(['clear arp-cache', 'clear history'])('`%s` y repond', async (command) => {
    expect(await (await switchDevice()).executeCommand(command)).toBe('');
  });

  it('`clear ipv6 neighbors` y reste refusee — elle est propre au routeur', async () => {
    expect(await (await switchDevice()).executeCommand('clear ipv6 neighbors'))
      .toContain('Invalid input');
  });
});

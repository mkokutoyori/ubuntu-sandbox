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

interface Cli {
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function router(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

function switchDevice(): Cli {
  return createDevice('switch-cisco', 0, 0) as unknown as Cli;
}

const PLATEFORMES: Array<[string, () => Cli]> = [
  ['routeur', router],
  ['commutateur', switchDevice],
];

async function privileged(make: () => Cli): Promise<Cli> {
  const device = make();
  await device.executeCommand('enable');
  return device;
}

const PRIVILEGIEES = [
  'show running-config',
  'show running-config all',
  'show startup-config',
  'show configuration',
];

describe.each(PLATEFORMES)('%s — les vues de configuration sont privilegiees', (_nom, make) => {
  it.each(PRIVILEGIEES)('`%s` est refusee en EXEC utilisateur', async (command) => {
    expect(await make().executeCommand(command)).toContain('Invalid input');
  });

  it.each(PRIVILEGIEES)('et acceptee en EXEC privilegie — `%s`', async (command) => {
    expect(await (await privileged(make)).executeCommand(command))
      .not.toContain('Invalid input');
  });

  it('`show version` reste au niveau 1 — un operateur sans privilege la tape', async () => {
    expect(await make().executeCommand('show version')).toContain('Cisco IOS Software');
  });
});

describe.each(PLATEFORMES)('%s — `show configuration` est le synonyme de `show startup-config`', (_nom, make) => {
  it('les deux rendent le meme texte', async () => {
    const device = await privileged(make);

    expect(await device.executeCommand('show configuration'))
      .toBe(await device.executeCommand('show startup-config'));
  });

  it('et `show conf` abrege ne contourne PAS le niveau', async () => {
    expect(await make().executeCommand('show conf')).toContain('Invalid input');
  });

  it('la sauvegarde se relit par les deux noms', async () => {
    const device = await privileged(make);
    await device.executeCommand('write memory');

    for (const command of ['show startup-config', 'show configuration']) {
      expect(await device.executeCommand(command)).not.toContain('not present');
    }
  });
});

describe.each(PLATEFORMES)('%s — `show running-config all` n\'annonce la construction QU\'UNE fois', (_nom, make) => {
  it('une seule ligne `Building configuration...`', async () => {
    const sortie = await (await privileged(make)).executeCommand('show running-config all');

    const bannieres = sortie.split('\n').filter(l => l.startsWith('Building configuration'));

    expect(bannieres).toHaveLength(1);
  });

  it('et `show running-config` non plus — le temoin', async () => {
    const sortie = await (await privileged(make)).executeCommand('show running-config');

    expect(sortie.split('\n').filter(l => l.startsWith('Building configuration')))
      .toHaveLength(1);
  });
});

describe.each(PLATEFORMES)('%s — le filtrage par niveau survit a la migration', (_nom, make) => {
  it('un niveau reduit voit MOINS que le niveau 15', async () => {
    const device = await privileged(make);
    await device.executeCommand('configure terminal');
    await device.executeCommand('privilege exec level 5 show running-config');
    await device.executeCommand('end');
    const complet = await device.executeCommand('show running-config');

    await device.executeCommand('disable');
    await device.executeCommand('enable 5');
    const reduit = await device.executeCommand('show running-config');

    expect(reduit).toContain('Building configuration...');
    expect(reduit.length).toBeLessThan(complet.length);
  });
});

describe.each(PLATEFORMES)('%s — `show running-config interface` nomme son interface', (_nom, make) => {
  it('sans argument, la commande est incomplete', async () => {
    expect(await (await privileged(make)).executeCommand('show running-config interface'))
      .toContain('Incomplete');
  });

  it('avec une interface reelle, elle rend son bloc', async () => {
    const sortie = await (await privileged(make))
      .executeCommand('show running-config interface GigabitEthernet0/0');

    expect(sortie).not.toContain('Invalid input');
    expect(sortie).toContain('interface');
  });
});

describe.each(PLATEFORMES)('%s — l\'aide et la tabulation suivent', (_nom, make) => {
  it('`show running-config ?` propose ses deux suites et `<cr>`', async () => {
    const aide = (await privileged(make)).cliHelp('show running-config ');

    expect(aide).toContain('all');
    expect(aide).toContain('interface');
    expect(aide).toContain('<cr>');
  });

  it.each([
    ['sho runn', 'show running-config'],
    ['show star', 'show startup-config'],
    ['sho ver', 'show version'],
  ])('`%s` se complete en `%s`, sans garder l\'abreviation', async (frappe, attendu) => {
    const candidats = (await privileged(make)).cliTabCandidates(frappe);

    expect(candidats).toEqual([attendu]);
  });
});

describe('une seule declaration par chemin', () => {
  it('le commutateur ne declare plus `show version` deux fois', async () => {
    const device = switchDevice() as unknown as Cli & {
      getShell(): { enumerateAllExecutablePaths(): string[] };
    };
    await device.executeCommand('enable');

    const chemins = device.getShell().enumerateAllExecutablePaths()
      .filter(p => p === 'show version');

    expect(chemins).toEqual([]);
  });
});

describe('un refus de NIVEAU dit qu\'il manque un privilege, pas que la commande existe pas', () => {
  async function niveauCinq(): Promise<Cli> {
    const device = await privileged(router);
    await device.executeCommand('configure terminal');
    await device.executeCommand('privilege exec level 1 show');
    await device.executeCommand('privilege exec level 5 show running-config');
    await device.executeCommand('username t privilege 5 secret Tech5!');
    await device.executeCommand('end');
    await device.executeCommand('disable');
    await (device as unknown as {
      executeCommand(c: string, o: unknown): Promise<string>;
    }).executeCommand('enable 5', { passwordInput: 'Tech5!' });
    return device;
  }

  it('`show running-config` passe au niveau 5 — le socle du cas', async () => {
    expect(await (await niveauCinq()).executeCommand('show running-config'))
      .toContain('Building configuration...');
  });

  it.each([
    'show running-config interface GigabitEthernet0/0',
    'show running-config all',
    'show startup-config',
  ])('`%s` est refusee SANS caret — aucun mot n\'est fautif', async (command) => {
    const sortie = await (await niveauCinq()).executeCommand(command);

    expect(sortie).toBe('% Invalid input detected at \'^\' marker.');
  });

  it('une commande VRAIMENT inconnue garde son caret — le temoin', async () => {
    const sortie = await (await niveauCinq()).executeCommand('show zorglub');

    expect(sortie.split('\n')).toHaveLength(2);
    expect(sortie).toContain('^');
  });
});

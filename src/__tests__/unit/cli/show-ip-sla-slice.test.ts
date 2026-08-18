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

async function privileged(): Promise<Cli> {
  const device = router();
  await device.executeCommand('enable');
  return device;
}

async function deuxOperations(): Promise<Cli> {
  const device = await privileged();
  for (const c of ['configure terminal',
    'ip sla 1', 'icmp-echo 10.0.0.2', 'exit',
    'ip sla 2', 'icmp-echo 10.0.0.3', 'exit',
    'ip sla schedule 1 life forever start-time now',
    'ip sla schedule 2 life forever start-time now', 'end']) {
    await device.executeCommand(c);
  }
  return device;
}

const VUES = [
  'show ip sla',
  'show ip sla application',
  'show ip sla configuration',
  'show ip sla statistics',
  'show ip sla summary',
  'show ip sla history',
  'show ip sla reaction-configuration',
  'show ip sla reaction-trigger',
  'show ip sla group schedule',
  'show ip sla responder',
];

describe('les vues restent au niveau 1, une par une', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await router().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('`clear ip sla` passe au niveau 15 — elle DETRUIT une mesure', () => {
  it.each(['clear ip sla statistics', 'clear ip sla enhanced-history'])(
    '`%s` est refusee en EXEC utilisateur', async (command) => {
      expect(await router().executeCommand(command)).toContain('Invalid input');
    });

  it.each(['clear ip sla statistics', 'clear ip sla enhanced-history'])(
    'et acceptee en EXEC privilegie — `%s`', async (command) => {
      expect(await (await privileged()).executeCommand(command)).toBe('');
    });

  it('elle efface pour de bon les compteurs d\'une operation', async () => {
    const device = await deuxOperations();
    const avant = await device.executeCommand('show ip sla statistics 1');

    expect(avant).toContain('Number of failures');

    await device.executeCommand('clear ip sla statistics 1');
    const apres = await device.executeCommand('show ip sla statistics 1');

    expect(apres).toContain('Number of failures: 0');
  });

  it('une operation inconnue est nommee, pas avalee', async () => {
    expect(await (await deuxOperations()).executeCommand('clear ip sla statistics 99'))
      .toContain('does not exist');
  });
});

describe('l\'argument d\'operation FILTRE — les trois vues, pas deux', () => {
  it('`show ip sla configuration 2` ne montre que la 2', async () => {
    const sortie = await (await deuxOperations()).executeCommand('show ip sla configuration 2');

    expect(sortie).toContain('Entry number: 2');
    expect(sortie).not.toContain('Entry number: 1');
  });

  it('`show ip sla statistics 1` ne montre que la 1', async () => {
    const sortie = await (await deuxOperations()).executeCommand('show ip sla statistics 1');

    expect(sortie).toContain('operation id: 1');
    expect(sortie).not.toContain('operation id: 2');
  });

  it('`show ip sla summary 1` ne montre que la 1 — le defaut corrige', async () => {
    const device = await deuxOperations();

    const toutes = await device.executeCommand('show ip sla summary');
    const une = await device.executeCommand('show ip sla summary 1');

    expect(toutes.match(/^\*\d+/gm)).toEqual(['*1', '*2']);
    expect(une.match(/^\*\d+/gm)).toEqual(['*1']);
  });

  it('un numero qui n\'existe pas ne rend aucune ligne d\'operation', async () => {
    const sortie = await (await deuxOperations()).executeCommand('show ip sla summary 99');

    expect(sortie).toContain('IPSLAs Latest Operation Summary');
    expect(sortie.match(/^\*\d+/gm)).toBeNull();
  });
});

describe('l\'aide declare ses suites au lieu de les gratter dans le code', () => {
  it('`show ip sla ?` propose les neuf branches et `<cr>`', async () => {
    const aide = (await privileged()).cliHelp('show ip sla ');

    for (const mot of ['application', 'configuration', 'statistics', 'summary',
      'history', 'reaction-configuration', 'reaction-trigger', 'responder']) {
      expect(aide, mot).toContain(mot);
    }
    expect(aide).toContain('<cr>');
  });

  it('`show ip sla statistics ?` garde `aggregated` et `details`', async () => {
    const aide = (await privileged()).cliHelp('show ip sla statistics ');

    expect(aide).toContain('aggregated');
    expect(aide).toContain('details');
  });

  it.each([
    ['show ip sla stat', 'show ip sla statistics'],
    ['show ip sla summ', 'show ip sla summary'],
    ['show ip sla respo', 'show ip sla responder'],
  ])('`%s` se complete en `%s`', async (frappe, attendu) => {
    expect((await privileged()).cliTabCandidates(frappe)).toEqual([attendu]);
  });
});

describe('ce que la migration ne devait PAS changer', () => {
  it('`show ip sla` nu rend toujours le bloc application — un alias voulu', async () => {
    const device = await privileged();

    expect(await device.executeCommand('show ip sla'))
      .toBe(await device.executeCommand('show ip sla application'));
  });

  it('`show ip sla monitor` reste refusee — IOS 15 a supprime la branche', async () => {
    expect(await (await privileged()).executeCommand('show ip sla monitor'))
      .toContain('Invalid input');
  });

  it('un mot inconnu apres `show ip sla` est refuse', async () => {
    expect(await (await privileged()).executeCommand('show ip sla nimportequoi'))
      .toContain('Invalid input');
  });

  it('`show ip sla statistics aggregated` rend bien la vue agregee', async () => {
    expect(await (await deuxOperations()).executeCommand('show ip sla statistics aggregated'))
      .toContain('IPSLAs aggregated statistics');
  });
});

describe('le commutateur n\'a pas IP SLA, et ne l\'a toujours pas', () => {
  it.each(['show ip sla', 'show ip sla statistics', 'clear ip sla statistics'])(
    '`%s` y reste refusee', async (command) => {
      const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
      await device.executeCommand('enable');

      expect(await device.executeCommand(command)).toContain('Invalid input');
    });
});

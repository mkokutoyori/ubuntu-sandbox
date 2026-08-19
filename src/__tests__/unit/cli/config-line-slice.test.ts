import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
import { MACAddress, resetCounters } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { CommandTrie } from '@/network/devices/shells/CommandTrie';

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

const PLATEFORMES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `SW${serial++}`, 24, 0, 0) as unknown as Cli],
];

async function surLigne(faire: () => Cli, ligne: string): Promise<Cli> {
  const device = faire();
  device.powerOn();
  for (const c of ['enable', 'configure terminal', ligne]) await device.executeCommand(c);
  return device;
}

const vty = (faire: () => Cli) => surLigne(faire, 'line vty 0 4');
const console0 = (faire: () => Cli) => surLigne(faire, 'line console 0');

describe('l\'arbre du mode ligne est VIDE sur les deux plateformes', () => {
  it.each(PLATEFORMES.map(([nom]) => nom))('%s', (nom) => {
    const device = PLATEFORMES.find(([n]) => n === nom)![1]();
    device.powerOn();
    const shell = (device as unknown as { shell: Record<string, unknown> }).shell;
    const trie = shell.configLineTrie as CommandTrie;
    expect(trie.enumerateExecutablePaths()).toEqual([]);
  });
});

const REGLAGES = [
  'login local',
  'password Secret123',
  'exec-timeout 5 0',
  'privilege level 15',
  'logging synchronous',
  'history size 50',
  'length 24',
  'width 80',
  'transport input ssh',
  'access-class 10 in',
  'motd-banner',
  'absolute-timeout 30',
  'session-timeout 10',
  'autocommand show users',
  'rotary 1',
  'escape-character 3',
  'login-timeout 45',
];

describe('les dix-sept reglages d\'une vty sont acceptes', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await vty(PLATEFORMES[0][1])).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('la configuration rendue reproduit ce qui a ete tape', () => {
  it('les reglages poses ressortent dans le bloc `line vty`', async () => {
    const device = await vty(PLATEFORMES[0][1]);
    for (const c of REGLAGES) await device.executeCommand(c);
    await device.executeCommand('end');

    const rendu = String(await device.executeCommand('show running-config'));
    const bloc = rendu.slice(rendu.indexOf('line vty'));
    for (const attendu of ['exec-timeout 5 0', 'password Secret123', 'login local',
      'privilege level 15', 'history size 50', 'length 24', 'width 80',
      'transport input ssh', 'access-class 10 in', 'logging synchronous']) {
      expect(bloc, attendu).toContain(attendu);
    }
  });

  it('un mot de passe de PLUSIEURS mots garde ses mots', async () => {
    const device = await vty(PLATEFORMES[0][1]);
    await device.executeCommand('password mon mot de passe');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('password mon mot de passe');
  });
});

describe('une negation se tape SANS la valeur que le positif exige', () => {
  it('`no password` efface le mot de passe', async () => {
    const device = await vty(PLATEFORMES[0][1]);
    await device.executeCommand('password Secret123');
    expect(await device.executeCommand('no password')).not.toContain('Invalid input');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .not.toContain('password Secret123');
  });

  it('`no privilege level` rend la main au compte', async () => {
    const device = await console0(PLATEFORMES[0][1]);
    await device.executeCommand('privilege level 15');
    expect(await device.executeCommand('no privilege level'))
      .not.toContain('Invalid input');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .not.toContain('privilege level 15');
  });

  it('`password` SEULE reste incomplete — la valeur est exigee', async () => {
    expect(await (await vty(PLATEFORMES[0][1])).executeCommand('password'))
      .toContain('% Incomplete command.');
  });

  it('`no ?` liste ce qui sait se defaire, avec les intitules de la negation',
    async () => {
      const aide = (await vty(PLATEFORMES[0][1])).cliHelp('no ');
      expect(aide).toContain('Clear the line password');
      expect(aide).toContain('Disable authentication on the line');
    });

  it('`?` propose `no` au premier rang', async () => {
    expect((await vty(PLATEFORMES[0][1])).cliHelp(''))
      .toContain('Negate a command or set its defaults');
  });
});

describe('la LIGNE choisie decide de ce qui existe', () => {
  const SERIE = ['parity even', 'speed 9600', 'databits 8', 'stopbits 1',
    'flowcontrol none'];

  it.each(SERIE)('`%s` est refusee sur une vty', async (commande) => {
    expect(await (await vty(PLATEFORMES[0][1])).executeCommand(commande))
      .toContain('% Invalid input');
  });

  it.each(SERIE)('`%s` est acceptee sur la console', async (commande) => {
    expect(await (await console0(PLATEFORMES[0][1])).executeCommand(commande))
      .not.toContain('Invalid input');
  });

  it('et `?` suit la meme regle des deux cotes', async () => {
    expect((await vty(PLATEFORMES[0][1])).cliHelp('')).not.toContain('parity');
    expect((await console0(PLATEFORMES[0][1])).cliHelp('')).toContain('parity');
  });
});

describe('`?` annonce la valeur attendue, pas la commande qui la porte', () => {
  const ATTENDU: ReadonlyArray<readonly [string, string]> = [
    ['privilege level ', '<0-15>'],
    ['history size ', '<0-256>'],
    ['length ', '<0-512>'],
    ['width ', '<0-512>'],
    ['session-timeout ', '<0-35791>'],
    ['rotary ', '<1-100>'],
    ['login-timeout ', '<1-300>'],
    ['password ', 'LINE'],
  ];

  it.each(ATTENDU)('`%s?` annonce %s', async (entree, attendu) => {
    expect((await vty(PLATEFORMES[0][1])).cliHelp(entree)).toContain(attendu);
  });

  it('les valeurs de la liaison serie sont des VALEURS, pas des freres',
    async () => {
      const device = await console0(PLATEFORMES[0][1]);
      expect(device.cliHelp('parity ')).toContain('even');
      expect(device.cliHelp('speed ')).toContain('9600');
      expect(device.cliHelp('stopbits ')).toContain('1');
      expect(device.cliHelp('flowcontrol ')).toContain('hardware');
    });

  it('`transport ?` rend la DIRECTION, et la direction rend le protocole',
    async () => {
      const device = await vty(PLATEFORMES[0][1]);
      const direction = device.cliHelp('transport ');
      expect(direction).toContain('input');
      expect(direction).toContain('output');
      expect(device.cliHelp('transport input ')).toContain('ssh');
    });
});

describe('la delegation de privileges survit a la migration', () => {
  it('`privilege exec level 7 <commande>` reste acceptee en configuration',
    async () => {
      const device = PLATEFORMES[0][1]();
      device.powerOn();
      await device.executeCommand('enable');
      await device.executeCommand('configure terminal');
      expect(await device.executeCommand('privilege exec level 7 show version'))
        .not.toContain('Invalid input');
    });
});

describe('`access-class` nomme sa liste PUIS sa direction', () => {
  it('`access-class ?` annonce les deux formes de liste', async () => {
    const aide = (await vty(PLATEFORMES[0][1])).cliHelp('access-class ');
    expect(aide).toContain('<1-199>');
    expect(aide).toContain('WORD');
    expect(aide).not.toContain('Inbound packets');
  });

  it('la direction revient une fois la liste nommee', async () => {
    const aide = (await vty(PLATEFORMES[0][1])).cliHelp('access-class 10 ');
    expect(aide).toContain('in');
    expect(aide).toContain('out');
  });

  it('et la commande complete est acceptee', async () => {
    expect(await (await vty(PLATEFORMES[0][1])).executeCommand('access-class 10 in'))
      .not.toContain('Invalid input');
  });
});

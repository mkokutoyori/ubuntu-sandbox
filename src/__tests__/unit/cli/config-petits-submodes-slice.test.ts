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

function nu(commutateur = false): Cli {
  const device = (commutateur
    ? new CiscoSwitch('switch-cisco', `S${serial++}`)
    : new CiscoRouter(`R${serial++}`, 0, 0)) as unknown as Cli;
  device.powerOn();
  return device;
}

async function dans(entree: readonly string[], commutateur = false): Promise<Cli> {
  const device = nu(commutateur);
  for (const c of ['enable', 'configure terminal', ...entree]) {
    await device.executeCommand(c);
  }
  return device;
}

function trie(device: Cli, champ: string): CommandTrie {
  return (device as unknown as { shell: Record<string, unknown> }).shell[champ] as CommandTrie;
}

const TRACK = ['track 1 interface GigabitEthernet0/0 line-protocol'];
const TRACK_LISTE = ['track 10 list boolean and'];
const KEYCHAIN = ['key chain KC'];
const KEYCHAIN_KEY = ['key chain KC', 'key 1'];
const ROUTE_MAP = ['route-map RM permit 10'];
const VRF = ['ip vrf CLIENT'];
const VUE = ['aaa new-model', 'parser view LECTURE'];

describe('les six derniers petits sous-modes sont VIDES', () => {
  it.each([
    'configTrackTrie', 'configKeychainTrie', 'configKeychainKeyTrie',
    'configRouteMapTrie', 'configVrfTrie', 'configViewTrie',
  ])('%s ne porte plus aucun chemin sur le routeur', (champ) => {
    expect(trie(nu(), champ).enumerateExecutablePaths()).toEqual([]);
  });

  it('configViewTrie ne porte plus aucun chemin sur le commutateur non plus', () => {
    expect(trie(nu(true), 'configViewTrie').enumerateExecutablePaths()).toEqual([]);
  });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [TRACK_LISTE, 'object 1'],
  [TRACK_LISTE, 'object 1 not'],
  [TRACK_LISTE, 'object 2 weight 20'],
  [TRACK_LISTE, 'no object 1'],
  [TRACK_LISTE, 'threshold up 2 down 1'],
  [TRACK, 'delay up 10 down 20'],
  [TRACK, 'no delay'],
  [TRACK, 'track 2 interface GigabitEthernet0/1 line-protocol'],
  [KEYCHAIN, 'key 1'],
  [KEYCHAIN, 'description la chaine de RIP'],
  [KEYCHAIN, 'no key 1'],
  [KEYCHAIN_KEY, 'key-string SecretPartage'],
  [KEYCHAIN_KEY, 'key-string 0 SecretEnClair'],
  [KEYCHAIN_KEY, 'cryptographic-algorithm hmac-sha-256'],
  [KEYCHAIN_KEY, 'accept-lifetime 00:00:00 1 Jan 2026 infinite'],
  [KEYCHAIN_KEY, 'send-lifetime 00:00:00 1 Jan 2026 infinite'],
  [KEYCHAIN_KEY, 'send-id 12'],
  [KEYCHAIN_KEY, 'recv-id 12'],
  [ROUTE_MAP, 'match ip address 10'],
  [ROUTE_MAP, 'set local-preference 200'],
  [ROUTE_MAP, 'no match ip address'],
  [ROUTE_MAP, 'no set local-preference'],
  [ROUTE_MAP, 'description la clause de sortie'],
  [VRF, 'rd 65000:1'],
  [VRF, 'route-target export 65000:1'],
  [VRF, 'description le client A'],
  [VUE, 'secret 0 MotDePasse'],
  [VUE, 'commands exec include show version'],
  [VUE, 'commands exec include all show'],
  [VUE, 'commands exec exclude show running-config'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('la vue est la MEME sur les deux plateformes', () => {
  it.each([
    'secret 0 MotDePasse', 'commands exec include show version',
  ])('`%s` est accepte sur le commutateur', async (commande) => {
    expect(await (await dans(VUE, true)).executeCommand(commande))
      .not.toContain('Invalid input');
  });

  it('les deux plateformes decrivent `commands` avec les memes mots', async () => {
    const routeur = (await dans(VUE)).cliHelp('commands ');
    const commutateur = (await dans(VUE, true)).cliHelp('commands ');
    expect(routeur).toContain('EXEC mode commands');
    expect(commutateur).toBe(routeur);
  });
});

describe('le reglage atteint son moteur', () => {
  it('le distingueur de route ressort dans la configuration', async () => {
    const device = await dans(VRF);
    await device.executeCommand('rd 65000:1');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config')).toContain('65000:1');
  });

  it('la clause de route-map garde son critere', async () => {
    const device = await dans(ROUTE_MAP);
    await device.executeCommand('match ip address 10');
    await device.executeCommand('end');
    expect(await device.executeCommand('show route-map')).toContain('ip address 10');
  });

  it('la cle garde sa chaine et son algorithme', async () => {
    const device = await dans(KEYCHAIN_KEY);
    await device.executeCommand('key-string SecretPartage');
    await device.executeCommand('cryptographic-algorithm hmac-sha-256');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show key chain');
    expect(vue).toContain('SecretPartage');
    expect(vue).toContain('hmac-sha-256');
  });

  it('le delai de l\'objet suivi est retenu', async () => {
    const device = await dans(TRACK);
    await device.executeCommand('delay up 10 down 20');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show track 1');
    expect(vue).not.toContain('Invalid input');
  });

  it('la vue refuse une commande qui n\'existe pas', async () => {
    expect(await (await dans(VUE)).executeCommand('commands exec include show zorglub'))
      .toContain('Command not found');
  });
});

describe('`?` nomme la place au lieu d\'un mot muet', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [TRACK_LISTE, 'object ', '<1-1000>'],
    [TRACK_LISTE, 'threshold ', 'Value at or above which the list is up'],
    [TRACK, 'delay ', 'Delay before reporting the object down'],
    [KEYCHAIN, 'key ', 'Key identifier'],
    [KEYCHAIN, 'description ', 'LINE'],
    [KEYCHAIN_KEY, 'cryptographic-algorithm ', 'HMAC-SHA-256'],
    [KEYCHAIN_KEY, 'send-id ', '<0-255>'],
    [KEYCHAIN_KEY, 'accept-lifetime ', 'Start time and date'],
    [ROUTE_MAP, 'match ', 'Criterion the route must satisfy'],
    [ROUTE_MAP, 'set ', 'Value the route-map applies to a matching route'],
    [VRF, 'rd ', 'ASN:nn or IP-address:nn'],
    [VRF, 'route-target ', 'import, export or both'],
    [VUE, 'commands ', 'Interface configuration commands'],
    [VUE, 'commands exec ', 'Add a command to the view and reserve it for this view'],
    [VUE, 'secret ', 'LINE'],
    [VUE, 'view ', 'Name of the member view'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it('un algorithme inconnu est refuse au caret', async () => {
    expect(await (await dans(KEYCHAIN_KEY)).executeCommand('cryptographic-algorithm sha3'))
      .toContain('Invalid input detected');
  });

  it('un identifiant d\'emission hors bornes est refuse au caret', async () => {
    expect(await (await dans(KEYCHAIN_KEY)).executeCommand('send-id 256'))
      .toContain('Invalid input detected');
  });

  it('un mode de vue inconnu est refuse au caret', async () => {
    expect(await (await dans(VUE)).executeCommand('commands router include network'))
      .toContain('Invalid input detected');
  });
});

describe('un noeud garde le nom de SON mode', () => {
  it('`match` se decrit autrement sous une route-map et sous une classe', async () => {
    expect((await dans(ROUTE_MAP)).cliHelp('')).toContain('Match clause');
    expect((await dans(['class-map CM'])).cliHelp('')).toContain('Match criteria');
  });

  it('`description` existe dans les trois sous-modes qui la portent', async () => {
    for (const entree of [KEYCHAIN, ROUTE_MAP, VRF]) {
      expect((await dans(entree)).cliHelp('')).toContain('description');
    }
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`crypto` se complete dans la cle', async () => {
    expect((await dans(KEYCHAIN_KEY)).cliTabCandidates('crypto'))
      .toEqual(['cryptographic-algorithm']);
  });

  it('`route-t` garde son mot dans le VRF', async () => {
    expect((await dans(VRF)).cliTabCandidates('route-t')).toEqual(['route-target']);
  });
});

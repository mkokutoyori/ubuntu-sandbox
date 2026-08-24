import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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

function nu(): Cli {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  return device;
}

async function dans(entree: readonly string[]): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', ...entree]) {
    await device.executeCommand(c);
  }
  return device;
}

const PROPOSITION = ['crypto ikev2 proposal PROP'];
const POLITIQUE = ['crypto ikev2 policy 10'];
const KEYRING = ['crypto ikev2 keyring KR'];
const PAIR = ['crypto ikev2 keyring KR', 'peer P1'];
const PROFIL = ['crypto ikev2 profile PR'];
const GDOI = ['crypto gdoi group G1'];

describe('les six arbres IKEv2 et GDOI sont VIDES', () => {
  it.each([
    'configIkev2ProposalTrie', 'configIkev2PolicyTrie', 'configIkev2KeyringTrie',
    'configIkev2KeyringPeerTrie', 'configIkev2ProfileTrie', 'configGdoiGroupTrie',
  ])('%s ne porte plus aucun chemin', (champ) => {
    const shell = (nu() as unknown as { shell: Record<string, unknown> }).shell;
    expect((shell[champ] as CommandTrie).enumerateExecutablePaths()).toEqual([]);
  });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [PROPOSITION, 'encryption aes-cbc-256 aes-gcm-256'],
  [PROPOSITION, 'integrity sha256 sha512'],
  [PROPOSITION, 'group 14 19 21'],
  [PROPOSITION, 'prf sha256'],
  [POLITIQUE, 'proposal PROP'],
  [POLITIQUE, 'match address local 10.0.0.1'],
  [KEYRING, 'peer P1'],
  [PAIR, 'address 10.0.0.1'],
  [PAIR, 'pre-shared-key ChildRekeyV2'],
  [PAIR, 'pre-shared-key local LocalKey123'],
  [PAIR, 'pre-shared-key remote RemoteKey123'],
  [PROFIL, 'match identity remote address 10.0.0.1'],
  [PROFIL, 'match identity remote any'],
  [PROFIL, 'authentication local pre-share'],
  [PROFIL, 'authentication remote rsa-sig'],
  [PROFIL, 'keyring KR'],
  [PROFIL, 'keyring local IKEV2-KR'],
  [PROFIL, 'identity local address 10.0.0.1'],
  [PROFIL, 'self-identity address'],
  [PROFIL, 'dpd 10 3 periodic'],
  [PROFIL, 'lifetime 3600'],
  [GDOI, 'identity number 1234'],
  [GDOI, 'match address ipv4 101'],
  [GDOI, 'transform-set TS'],
  [GDOI, 'address ipv4 10.0.0.1'],
  [GDOI, 'server address ipv4 10.0.0.9'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('une proposition IKEv2 accepte une LISTE, pas une seule valeur', () => {
  it('les algorithmes atteignent le moteur', async () => {
    const device = await dans(PROPOSITION);
    await device.executeCommand('encryption aes-cbc-256 aes-gcm-256');
    await device.executeCommand('integrity sha256 sha512');
    await device.executeCommand('group 14 19 21');
    await device.executeCommand('end');
    const vue = await device.executeCommand('show crypto ikev2 proposal');
    expect(vue).toContain('aes-cbc-256');
    expect(vue).toContain('sha256');
  });
});

describe('`?` nomme ce que la commande accepte', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [PROPOSITION, 'encryption ', 'AES-CBC with a 256 bit key'],
    [PROPOSITION, 'integrity ', 'Secure Hash Standard 2 (512 bit)'],
    [PROPOSITION, 'group ', 'Diffie-Hellman group 19 (256 bit ECP)'],
    [PROPOSITION, 'prf ', 'Message Digest 5'],
    [POLITIQUE, 'match address local ', 'A.B.C.D'],
    [KEYRING, 'peer ', 'Name of the peer block'],
    [PAIR, 'address ', 'A.B.C.D'],
    [PAIR, 'pre-shared-key ', 'local'],
    [PROFIL, 'authentication local ', 'Elliptic Curve Digital Signature Algorithm'],
    [PROFIL, 'identity local ', 'Use an opaque key identifier'],
    [PROFIL, 'dpd ', '<10-3600>'],
    [PROFIL, 'lifetime ', '<120-86400>'],
    [PROFIL, 'match identity remote ', 'Match any remote identity'],
    [GDOI, 'identity number ', '<1-2147483647>'],
    [GDOI, 'address ipv4 ', 'A.B.C.D'],
    [GDOI, 'server ', 'Activate this router as the GDOI key server'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it('une methode d\'authentification inconnue est refusee au caret', async () => {
    expect(await (await dans(PROFIL)).executeCommand('authentication local kerberos'))
      .toContain('Invalid input detected');
  });

  it('un intervalle DPD hors bornes est refuse au caret', async () => {
    expect(await (await dans(PROFIL)).executeCommand('dpd 5 3 periodic'))
      .toContain('Invalid input detected');
  });
});

describe('une legende suit le MODE, elle ne le traverse pas', () => {
  it('`authentication` se decrit autrement sous IKEv2 et sous ISAKMP', async () => {
    expect((await dans(PROFIL)).cliHelp('')).toContain('Authentication method');
    expect((await dans(['crypto isakmp policy 10'])).cliHelp(''))
      .toContain('Set authentication method');
  });

  it('`identity` se decrit autrement sous IKEv2 et sous GDOI', async () => {
    expect((await dans(PROFIL)).cliHelp('')).toContain('Local identity');
    expect((await dans(GDOI)).cliHelp('')).toContain('Identity of the GDOI group');
  });

  it('un noeud intermediaire ne prend plus le nom de son enfant', async () => {
    const aide = (await dans(PROFIL)).cliHelp('match identity ');
    expect(aide).toContain('Match the remote identity');
    expect(aide).not.toContain('Match remote identity by address');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`encry` se complete dans la proposition', async () => {
    expect((await dans(PROPOSITION)).cliTabCandidates('encry'))
      .toEqual(['encryption']);
  });

  it('`server addr` garde son mot', async () => {
    expect((await dans(GDOI)).cliTabCandidates('server addr'))
      .toEqual(['server address']);
  });
});

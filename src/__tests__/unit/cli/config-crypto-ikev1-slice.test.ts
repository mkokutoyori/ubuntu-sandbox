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

const ISAKMP = ['crypto isakmp policy 10'];
const PROFIL_ISAKMP = ['crypto isakmp profile PROF'];
const KEYRING = ['crypto keyring KR'];
const TFSET = ['crypto ipsec transform-set TS esp-aes 256 esp-sha-hmac'];
const CRYPTO_MAP = ['crypto map CM 10 ipsec-isakmp'];
const PROFIL_IPSEC = ['crypto ipsec profile P1'];

describe('les six arbres des sous-modes cryptographiques sont VIDES', () => {
  it.each([
    'configIsakmpTrie', 'configIsakmpProfileTrie', 'configKeyringTrie',
    'configTfsetTrie', 'configCryptoMapTrie', 'configIpsecProfileTrie',
  ])('%s ne porte plus aucun chemin', (champ) => {
    const shell = (nu() as unknown as { shell: Record<string, unknown> }).shell;
    expect((shell[champ] as CommandTrie).enumerateExecutablePaths()).toEqual([]);
  });
});

const REGLAGES: ReadonlyArray<readonly [readonly string[], string]> = [
  [ISAKMP, 'encryption aes 256'],
  [ISAKMP, 'encryption 3des'],
  [ISAKMP, 'hash sha256'],
  [ISAKMP, 'hash sha512'],
  [ISAKMP, 'authentication pre-share'],
  [ISAKMP, 'group 14'],
  [ISAKMP, 'lifetime 3600'],
  [PROFIL_ISAKMP, 'keyring KR'],
  [PROFIL_ISAKMP, 'match identity address 10.0.0.1'],
  [PROFIL_ISAKMP, 'match identity hostname rb'],
  [PROFIL_ISAKMP, 'self-identity address'],
  [PROFIL_ISAKMP, 'vrf V1'],
  [KEYRING, 'pre-shared-key address 10.0.0.1 key SECRET'],
  [TFSET, 'mode tunnel'],
  [TFSET, 'mode transport'],
  [TFSET, 'crypto ipsec transform-set AUTRE esp-aes esp-sha-hmac'],
  [TFSET, 'crypto ipsec security-association lifetime seconds 3600'],
  [TFSET, 'crypto ipsec security-association replay window-size 128'],
  [TFSET, 'crypto ipsec profile P9'],
  [CRYPTO_MAP, 'description un tunnel vers le siege'],
  [CRYPTO_MAP, 'set peer 10.0.0.2'],
  [CRYPTO_MAP, 'set transform-set TS'],
  [CRYPTO_MAP, 'match address 100'],
  [CRYPTO_MAP, 'set pfs group14'],
  [CRYPTO_MAP, 'set security-association lifetime seconds 3600'],
  [CRYPTO_MAP, 'reverse-route'],
  [CRYPTO_MAP, 'set ikev2-profile IK'],
  [CRYPTO_MAP, 'set isakmp-profile PROF'],
  [PROFIL_IPSEC, 'set transform-set TS'],
  [PROFIL_IPSEC, 'set pfs group14'],
  [PROFIL_IPSEC, 'set ikev2-profile IK'],
  [PROFIL_IPSEC, 'set security-association lifetime seconds 3600'],
];

describe('chaque reglage reste accepte apres la migration', () => {
  it.each(REGLAGES)('%s › `%s`', async (entree, commande) => {
    expect(await (await dans(entree)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('la politique ISAKMP atteint vraiment le moteur', () => {
  it('les cinq reglages ressortent dans `show crypto isakmp policy`', async () => {
    const device = await dans(ISAKMP);
    for (const c of ['encryption aes 256', 'hash sha256',
      'authentication pre-share', 'group 14', 'lifetime 3600']) {
      await device.executeCommand(c);
    }
    const vue = await device.executeCommand('do show crypto isakmp policy');
    expect(vue).toContain('AES');
    expect(vue).toContain('3600');
  });
});

describe('`?` nomme ce que la commande accepte, au lieu d\'un mot muet', () => {
  const ATTENDU: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [ISAKMP, 'encryption ', 'Three key triple DES'],
    [ISAKMP, 'hash ', 'Message Digest 5'],
    [ISAKMP, 'authentication ', 'Pre-Shared Key'],
    [ISAKMP, 'group ', 'Diffie-Hellman group 14 (2048 bit)'],
    [ISAKMP, 'lifetime ', '<60-86400>'],
    [PROFIL_ISAKMP, 'match identity address ', 'A.B.C.D'],
    [PROFIL_ISAKMP, 'self-identity ', 'Use the fully qualified domain name'],
    [KEYRING, 'pre-shared-key ', 'Identify the peer by address'],
    [KEYRING, 'pre-shared-key address ', 'A.B.C.D'],
    [KEYRING, 'pre-shared-key address 10.0.0.1 ', 'key'],
    [TFSET, 'mode ', 'Transport mode'],
    [TFSET, 'crypto ipsec security-association replay window-size ', '<64-1024>'],
    [CRYPTO_MAP, 'set peer ', 'A.B.C.D'],
    [CRYPTO_MAP, 'set pfs ', 'group14'],
    [CRYPTO_MAP, 'match address ', '<100-199>'],
    [CRYPTO_MAP, 'set security-association lifetime seconds ', '<120-86400>'],
    [PROFIL_IPSEC, 'set transform-set ', 'Name of the transform set'],
  ];

  it.each(ATTENDU)('%s › `%s?` annonce %s', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });

  it('une valeur hors de l\'enumeration est refusee au caret', async () => {
    expect(await (await dans(ISAKMP)).executeCommand('hash whirlpool'))
      .toContain('Invalid input detected');
  });

  it('une abreviation non ambigue reste acceptee', async () => {
    expect(await (await dans(ISAKMP)).executeCommand('hash sha3'))
      .not.toContain('Invalid input');
  });

  it('une duree hors bornes est refusee au caret', async () => {
    expect(await (await dans(ISAKMP)).executeCommand('lifetime 30'))
      .toContain('Invalid input detected');
  });
});

describe('un noeud intermediaire porte son propre nom', () => {
  const LIBELLES: ReadonlyArray<readonly [readonly string[], string, string]> = [
    [CRYPTO_MAP, '', 'Set values for encryption/decryption'],
    [CRYPTO_MAP, '', 'Match values'],
    [CRYPTO_MAP, 'set ', 'Security association parameters'],
    [CRYPTO_MAP, 'set security-association ', 'Security association lifetime'],
    [PROFIL_ISAKMP, 'match ', 'Match peer identity'],
    [TFSET, '', 'Encryption module'],
    [TFSET, 'crypto ', 'Configure IPSec policy'],
    [TFSET, 'crypto ipsec ', 'Security association parameters'],
    [TFSET, 'crypto ipsec security-association ', 'Anti-replay checking'],
  ];

  it.each(LIBELLES)('%s › `%s?` ecrit « %s »', async (entree, saisie, attendu) => {
    expect((await dans(entree)).cliHelp(saisie)).toContain(attendu);
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`encry` se complete dans la politique ISAKMP', async () => {
    expect((await dans(ISAKMP)).cliTabCandidates('encry')).toEqual(['encryption']);
  });

  it('`set trans` se complete dans la carte de chiffrement', async () => {
    expect((await dans(CRYPTO_MAP)).cliTabCandidates('set trans'))
      .toEqual(['set transform-set']);
  });

  it('`pre-shared-key address 10.0.0.1 k` garde l\'adresse deja tapee', async () => {
    expect((await dans(KEYRING)).cliTabCandidates('pre-shared-key address 10.0.0.1 k'))
      .toEqual(['pre-shared-key address 10.0.0.1 key']);
  });
});

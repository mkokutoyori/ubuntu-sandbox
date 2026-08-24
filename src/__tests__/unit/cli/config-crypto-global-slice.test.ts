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
}

let serial = 0;

async function enConfig(): Promise<Cli> {
  const device = new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli;
  device.powerOn();
  for (const c of ['enable', 'configure terminal']) await device.executeCommand(c);
  return device;
}

/*
 * La famille crypto GLOBALE : les commandes qui entrent dans les
 * sous-modes deja migres (IKEv1, IKEv2, GDOI) et les reglages qui
 * n'entrent nulle part. Formes relevees sur les gestionnaires, passees
 * sur le code NON MIGRE avant de l'etre.
 */
const REGLAGES: ReadonlyArray<string> = [
  'crypto isakmp policy 10',
  'crypto isakmp key SECRET address 10.0.0.1',
  'crypto isakmp key SECRET hostname pair.example.com',
  'crypto isakmp identity address',
  'crypto isakmp identity hostname',
  'crypto isakmp keepalive 10',
  'crypto isakmp keepalive 10 periodic',
  'crypto isakmp nat keepalive 20',
  'crypto isakmp invalid-spi-recovery',
  'crypto isakmp aggressive-mode disable',
  'crypto isakmp profile PROF',
  'crypto keyring KR',
  'crypto ipsec transform-set TS esp-aes esp-sha-hmac',
  'crypto ipsec profile IPP',
  'crypto ipsec security-association lifetime seconds 3600',
  'crypto ipsec security-association lifetime kilobytes 4608000',
  'crypto ipsec security-association replay window-size 128',
  'crypto ipsec security-association esn',
  'crypto map CM 10 ipsec-isakmp',
  'crypto dynamic-map DM 10',
  'crypto ikev2 proposal PROP',
  'crypto ikev2 policy 10',
  'crypto ikev2 keyring KR2',
  'crypto ikev2 profile PR2',
  'crypto ikev2 dpd 10 3 periodic',
  'crypto ikev2 cookie-challenge 50',
  'crypto ikev2 window 10',
  'crypto ikev2 nat keepalive 20',
  'crypto gdoi group G1',
  'no crypto isakmp policy 10',
  'no crypto isakmp key SECRET address 10.0.0.1',
  'no crypto ipsec transform-set TS',
  'no crypto ipsec profile IPP',
  'no crypto map CM',
  'no crypto dynamic-map DM',
  'no crypto ikev2 proposal PROP',
  'no crypto ikev2 policy 10',
  'no crypto ikev2 keyring KR2',
  'no crypto ikev2 profile PR2',
  'no crypto gdoi group G1',
];

describe('la famille crypto globale reste acceptee', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await enConfig()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('le gestionnaire garde ses refus, qui EXPLIQUENT', () => {
  it.each([
    ['crypto isakmp policy abc', 'Invalid priority'],
    ['crypto isakmp key SECRET', 'crypto isakmp key KEY'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s` explique', async (commande, attendu) => {
      expect(await (await enConfig()).executeCommand(commande)).toContain(attendu);
    });
});

describe('entrer dans un sous-mode migre fonctionne toujours', () => {
  it.each([
    ['crypto isakmp policy 10', 'encryption aes'],
    ['crypto ikev2 proposal PROP', 'encryption aes-cbc-256'],
    ['crypto ipsec profile IPP', 'set transform-set TS'],
    ['crypto gdoi group G1', 'identity number 1234'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s` puis `%s`', async (entree, dans) => {
      const device = await enConfig();
      await device.executeCommand(entree);
      expect(await device.executeCommand(dans)).not.toContain('Invalid input');
    });
});

describe('les trois arbres crypto globaux se vident', () => {
  it('aucun chemin crypto ne reste dans configTrie', () => {
    const d = new CiscoRouter('RZ', 0, 0) as unknown as Cli;
    d.powerOn();
    const shell = (d as unknown as { shell: Record<string, unknown> }).shell;
    const restants = (shell.configTrie as CommandTrie).enumerateExecutablePaths()
      .filter(p => /^(no )?crypto (isakmp|ikev2|ipsec|gdoi|map|dynamic-map|keyring)/.test(p));
    expect(restants).toEqual([]);
  });
});

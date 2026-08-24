import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { CiscoSwitch } from '@/network/devices/CiscoSwitch';
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
  powerOn(): void;
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
}

let serial = 0;

async function enConfig(commutateur = false): Promise<Cli> {
  const device = (commutateur
    ? new CiscoSwitch('switch-cisco', `S${serial++}`)
    : new CiscoRouter(`R${serial++}`, 0, 0)) as unknown as Cli;
  device.powerOn();
  for (const c of ['enable', 'configure terminal']) await device.executeCommand(c);
  return device;
}

/*
 * DHCP global. Huit chemins sont DUPLIQUES entre le routeur et le
 * commutateur, chacun avec sa propre ecriture ; ce releve est donc
 * passe sur les DEUX plateformes, sur le code non migre, pour que la
 * reduction de cette duplication soit verifiable et non supposee.
 */
const COMMUNS: ReadonlyArray<string> = [
  'ip dhcp pool LAN',
  'no ip dhcp pool LAN',
  'ip dhcp excluded-address 10.0.0.1 10.0.0.10',
  'ip dhcp database ftp://10.0.0.9/cfg',
  'ip dhcp snooping',
  'ip dhcp snooping vlan 10',
];

const ROUTEUR_SEUL: ReadonlyArray<string> = [
  'ip dhcp bootp ignore',
  'ip dhcp class MACLASSE',
  'ip dhcp compatibility suboption link-selection standard',
  'ip dhcp ping packets 2',
  'ip dhcp ping timeout 500',
  'ip dhcp relay information option',
  'ip dhcp relay information policy keep',
  'ip dhcp relay information trust-all',
  'ip dhcp smart-relay',
  'ip dhcp snooping information option',
  'ip dhcp use class',
  'no ip dhcp relay information option',
  'no ip dhcp relay information policy',
  'no ip dhcp relay information trust-all',
  'no ip dhcp smart-relay',
  'no ip dhcp snooping',
  'no ip dhcp snooping information option',
  'no ip dhcp snooping vlan 10',
];

describe('DHCP global reste accepte sur le routeur', () => {
  it.each([...COMMUNS, ...ROUTEUR_SEUL])('`%s`', async (commande) => {
    expect(await (await enConfig()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('les chemins COMMUNS restent acceptes sur le commutateur', () => {
  it.each(COMMUNS)('`%s`', async (commande) => {
    expect(await (await enConfig(true)).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('`ip dhcp pool` entre dans le sous-mode, sur les deux plateformes', () => {
  it.each([false, true])('commutateur=%s', async (commutateur) => {
    const device = await enConfig(commutateur);
    await device.executeCommand('ip dhcp pool LAN');
    expect(await device.executeCommand('network 10.0.0.0 255.255.255.0'))
      .not.toContain('Invalid input');
  });

  /*
   * Les deux ecritures divergeaient — le commutateur appelait
   * `enable()`, le routeur non — et la mesure dit que la consequence
   * est nulle : le service est actif des le depart des deux cotes,
   * comme `service dhcp` l'est par defaut sur un vrai IOS.
   */
  it.each([false, true])('le service DHCP est actif, commutateur=%s', async (commutateur) => {
    const device = await enConfig(commutateur);
    await device.executeCommand('ip dhcp pool LAN');
    const srv = (device as unknown as {
      _getDHCPServerInternal(): Record<string, unknown>;
    })._getDHCPServerInternal();
    const actif = typeof srv.isEnabled === 'function'
      ? (srv.isEnabled as () => boolean)() : srv.enabled;
    expect(actif).toBe(true);
  });
});

describe('l\'aide nomme les places de DHCP', () => {
  it.each([
    ['ip dhcp ', 'pool'],
    ['ip dhcp ', 'excluded-address'],
  ] as ReadonlyArray<readonly [string, string]>)(
    '`%s?` annonce %s', async (saisie, attendu) => {
      expect((await enConfig()).cliHelp(saisie)).toContain(attendu);
    });
});

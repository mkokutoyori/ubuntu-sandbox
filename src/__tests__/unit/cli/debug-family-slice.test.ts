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
}

let serial = 0;

function bare(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privileged(): Promise<Cli> {
  const device = bare();
  await device.executeCommand('enable');
  return device;
}

async function switchPrivileged(): Promise<Cli> {
  const device = createDevice('switch-cisco', 0, 0) as unknown as Cli;
  await device.executeCommand('enable');
  return device;
}

const MIGRATED = [
  'debug all',
  'debug crypto isakmp', 'debug crypto ipsec', 'debug crypto ikev2', 'debug crypto pki',
  'debug ip dhcp server', 'debug ip dhcp server events',
  'debug ip dhcp server linkage', 'debug ip dhcp server packets',
  'debug ip ospf',
];

describe('les deux directions ont le MEME niveau', () => {
  it.each(MIGRATED)('`%s` est refusee en EXEC utilisateur', async (command) => {
    expect(await bare().executeCommand(command)).toContain('Invalid input');
  });

  it.each(MIGRATED)('et `no %s` aussi', async (command) => {
    expect(await bare().executeCommand(`no ${command}`)).toContain('Invalid input');
  });

  it.each(MIGRATED)('les deux repondent en EXEC privilegie — `%s`', async (command) => {
    const device = await privileged();

    expect(await device.executeCommand(command)).not.toContain('Invalid input');
    expect(await device.executeCommand(`no ${command}`)).not.toContain('Invalid input');
  });
});

describe('chaque commande garde la reponse qu\'elle avait', () => {
  it.each([
    ['debug all', 'All possible debugging has been turned on'],
    ['no debug all', 'All possible debugging has been turned off'],
    ['debug crypto isakmp', 'Crypto ISAKMP debugging is on'],
    ['no debug crypto isakmp', 'Crypto ISAKMP debugging is off'],
    ['debug crypto ipsec', 'Crypto IPSEC debugging is on'],
    ['debug ip dhcp server', 'DHCP server debugging is on'],
    ['debug ip dhcp server events', 'DHCP server event debugging is on'],
    ['debug ip dhcp server linkage', 'DHCP server linkage debugging is on'],
    ['debug ip dhcp server packets', 'DHCP server packet debugging is on'],
    ['no debug ip dhcp server events', 'DHCP server event debugging is off'],
    ['debug ip ospf', 'OSPF adjacency debugging is on'],
    ['debug ip ospf adj', 'OSPF adjacency debugging is on'],
    ['no debug ip ospf', 'OSPF adjacency debugging is off'],
  ])('`%s` rend `%s`', async (command, attendu) => {
    expect(await (await privileged()).executeCommand(command)).toBe(attendu);
  });

  it.each(['debug crypto ikev2', 'debug crypto pki'])(
    '`%s` dit pourquoi elle ne trace rien plutot que de se taire', async (command) => {
      expect(await (await privileged()).executeCommand(command))
        .toContain('has no trace point on this platform');
    });
});

describe('les sous-mots sont de VRAIS enfants, pas une decoration d\'aide', () => {
  it('`debug ip dhcp server ?` propose ses trois choix', async () => {
    const aide = (await privileged()).cliHelp('debug ip dhcp server ');

    for (const mot of ['events', 'linkage', 'packets']) expect(aide).toContain(mot);
  });

  it('`debug ip ospf ?` propose les categories, pas un WORD nu', async () => {
    const aide = (await privileged()).cliHelp('debug ip ospf ');

    for (const mot of ['adj', 'events', 'spf', 'hello', 'packet']) expect(aide).toContain(mot);
  });

  it('`debug crypto ?` propose les quatre', async () => {
    const aide = (await privileged()).cliHelp('debug crypto ');

    for (const mot of ['isakmp', 'ipsec', 'ikev2', 'pki']) expect(aide).toContain(mot);
  });

  it('un sous-mot inconnu d\'OSPF est refuse, pas avale', async () => {
    expect(await (await privileged()).executeCommand('debug ip ospf zorglub'))
      .toContain('Invalid input');
  });
});

describe('l\'abreviation continue de marcher', () => {
  it.each([
    ['deb ip dhcp ser', 'DHCP server debugging is on'],
    ['deb cry isa', 'Crypto ISAKMP debugging is on'],
    ['deb ip osp', 'OSPF adjacency debugging is on'],
  ])('`%s` rend `%s`', async (command, attendu) => {
    expect(await (await privileged()).executeCommand(command)).toBe(attendu);
  });
});

describe('le commutateur garde ce qu\'il avait, et rien de plus', () => {
  it.each([
    ['debug all', 'All possible debugging has been turned on'],
    ['no debug all', 'All possible debugging has been turned off'],
  ])('`%s` y rend `%s` — une seule implementation pour les deux', async (command, attendu) => {
    expect(await (await switchPrivileged()).executeCommand(command)).toBe(attendu);
  });

  it.each(['debug crypto isakmp', 'debug ip ospf'])(
    '`%s` y reste refusee — elle est propre au routeur', async (command) => {
      expect(await (await switchPrivileged()).executeCommand(command))
        .toContain('Invalid input');
    });
});

describe('`debug ip nat` accepte ce qu\'IOS accepte, et allume le moteur', () => {
  it.each([
    ['debug ip nat', 'IP NAT debugging is on'],
    ['debug ip nat detailed', 'IP NAT detailed debugging is on'],
  ])('`%s` rend `%s`', async (command, attendu) => {
    expect(await (await privileged()).executeCommand(command)).toBe(attendu);
  });

  it('`debug ip nat <acl>` nomme la liste', async () => {
    expect(await (await privileged()).executeCommand('debug ip nat 10'))
      .toBe('IP NAT debugging is on for access list 10');
  });

  it('et le moteur NAT est vraiment allume, pas seulement la vue', async () => {
    const device = await privileged();
    const moteur = (device as unknown as {
      _getNATEngine(): { isDebugEnabled?: () => boolean; getDebugEnabled?: () => boolean };
    })._getNATEngine();

    await device.executeCommand('debug ip nat');

    const lu = moteur.isDebugEnabled?.() ?? moteur.getDebugEnabled?.();
    expect(lu).toBe(true);

    await device.executeCommand('no debug ip nat');

    expect(moteur.isDebugEnabled?.() ?? moteur.getDebugEnabled?.()).toBe(false);
  });
});

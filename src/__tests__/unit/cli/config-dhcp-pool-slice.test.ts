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
}

let serial = 0;

const PLATEFORMES: ReadonlyArray<readonly [string, () => Cli]> = [
  ['routeur', () => new CiscoRouter(`R${serial++}`, 0, 0) as unknown as Cli],
  ['commutateur',
    () => new CiscoSwitch('switch-cisco', `SW${serial++}`, 24, 0, 0) as unknown as Cli],
];

async function dansUnPool(faire: () => Cli): Promise<Cli> {
  const device = faire();
  device.powerOn();
  for (const c of ['enable', 'configure terminal', 'ip dhcp pool LAN']) {
    await device.executeCommand(c);
  }
  return device;
}

describe('l\'arbre du sous-mode pool est VIDE sur les deux plateformes', () => {
  it.each(PLATEFORMES.map(([nom]) => nom))('%s', (nom) => {
    const device = PLATEFORMES.find(([n]) => n === nom)![1]();
    device.powerOn();
    const shell = (device as unknown as { shell: Record<string, unknown> }).shell;
    expect((shell.configDhcpTrie as CommandTrie).enumerateExecutablePaths()).toEqual([]);
  });
});

const REGLAGES = [
  'network 192.168.1.0 255.255.255.0',
  'default-router 192.168.1.1',
  'dns-server 8.8.8.8 8.8.4.4',
  'domain-name lab.local',
  'lease 7',
  'lease infinite',
  'next-server 10.0.0.9',
  'bootfile boot.img',
  'netbios-name-server 10.0.0.5',
  'netbios-node-type h-node',
  'option 150 ip 10.0.0.7',
  'host 192.168.1.50 255.255.255.0',
  'hardware-address 0011.2233.4455',
  'client-identifier 0100.1122.3344.55',
  'client-name poste1',
  'class CL1',
];

for (const [nom, faire] of PLATEFORMES) {
  describe(`${nom} — les seize reglages du pool sont acceptes`, () => {
    it.each(REGLAGES)('`%s`', async (commande) => {
      expect(await (await dansUnPool(faire)).executeCommand(commande))
        .not.toContain('Invalid input');
    });
  });
}

describe('la configuration rendue reproduit le pool', () => {
  it('le bloc `ip dhcp pool` porte ce qui a ete tape', async () => {
    const device = await dansUnPool(PLATEFORMES[0][1]);
    for (const c of ['network 192.168.1.0 255.255.255.0', 'default-router 192.168.1.1',
      'dns-server 8.8.8.8 8.8.4.4', 'domain-name lab.local', 'lease 7']) {
      await device.executeCommand(c);
    }
    await device.executeCommand('end');

    const rendu = String(await device.executeCommand('show running-config'));
    const bloc = rendu.slice(rendu.indexOf('ip dhcp pool'));
    for (const attendu of ['network 192.168.1.0 255.255.255.0',
      'default-router 192.168.1.1', 'dns-server 8.8.8.8 8.8.4.4',
      'domain-name lab.local', 'lease 7']) {
      expect(bloc, attendu).toContain(attendu);
    }
  });

  it('une LISTE d\'adresses garde toutes ses adresses', async () => {
    const device = await dansUnPool(PLATEFORMES[0][1]);
    await device.executeCommand('dns-server 8.8.8.8 8.8.4.4 1.1.1.1');
    await device.executeCommand('end');
    expect(await device.executeCommand('show running-config'))
      .toContain('dns-server 8.8.8.8 8.8.4.4 1.1.1.1');
  });
});

describe('un reglage sans sa valeur est INCOMPLET, pas invalide', () => {
  it.each(['default-router', 'dns-server', 'lease', 'option', 'network'])(
    '`%s` seul', async (commande) => {
      expect(await (await dansUnPool(PLATEFORMES[0][1])).executeCommand(commande))
        .toContain('% Incomplete command.');
    });
});

describe('`?` annonce la place, et les formes que le gestionnaire lit', () => {
  it('`lease ?` annonce les jours ET `infinite`', async () => {
    const aide = (await dansUnPool(PLATEFORMES[0][1])).cliHelp('lease ');
    expect(aide).toContain('<0-365>');
    expect(aide).toContain('infinite');
  });

  it('`option ?` annonce le code avant ses formats', async () => {
    const aide = (await dansUnPool(PLATEFORMES[0][1])).cliHelp('option ');
    expect(aide).toContain('<0-254>');
    expect(aide).toContain('ascii');
    expect(aide).toContain('hex');
  });

  it('`netbios-node-type ?` rend les quatre types', async () => {
    const aide = (await dansUnPool(PLATEFORMES[0][1])).cliHelp('netbios-node-type ');
    for (const type of ['b-node', 'h-node', 'm-node', 'p-node']) {
      expect(aide, type).toContain(type);
    }
  });

  it('`network ?` annonce le reseau puis le masque', async () => {
    const device = await dansUnPool(PLATEFORMES[0][1]);
    expect(device.cliHelp('network ')).toContain('Network number');
    expect(device.cliHelp('network 192.168.1.0 ')).toContain('Network mask');
  });

  it('`?` garde a chaque noeud son propre nom', async () => {
    const aide = (await dansUnPool(PLATEFORMES[0][1])).cliHelp('');
    expect(aide).toContain('Set DHCP lease duration');
    expect(aide).toContain('Set a raw DHCP option');
    expect(aide).toContain('Manual binding client identifier');
  });
});

describe('`client-identifier deny` cesse d\'etre avalee par son parent', () => {
  it('la forme longue est acceptee', async () => {
    expect(await (await dansUnPool(PLATEFORMES[0][1]))
      .executeCommand('client-identifier deny 0100.1122.3344.55'))
      .not.toContain('Invalid input');
  });

  it('et la forme courte reste une liaison manuelle', async () => {
    expect(await (await dansUnPool(PLATEFORMES[0][1]))
      .executeCommand('client-identifier 0100.1122.3344.55'))
      .not.toContain('Invalid input');
  });
});

describe('les trois autres sous-modes DHCP sont vides eux aussi', () => {
  it.each(['configDhcpClassTrie', 'configDhcpPoolClassTrie', 'configIpv6DhcpTrie'])(
    '%s', (champ) => {
      const device = PLATEFORMES[0][1]();
      device.powerOn();
      const shell = (device as unknown as { shell: Record<string, unknown> }).shell;
      expect((shell[champ] as CommandTrie).enumerateExecutablePaths()).toEqual([]);
    });
});

describe('deux sous-modes nomment la MEME commande sans se confondre', () => {
  async function dansLePoolV6(): Promise<Cli> {
    const device = PLATEFORMES[0][1]();
    device.powerOn();
    for (const c of ['enable', 'configure terminal', 'ipv6 dhcp pool V6']) {
      await device.executeCommand(c);
    }
    return device;
  }

  it('`dns-server` prend une adresse IPv4 dans un pool, IPv6 dans l\'autre',
    async () => {
      expect((await dansUnPool(PLATEFORMES[0][1])).cliHelp('dns-server '))
        .toContain('A.B.C.D');
      expect((await dansLePoolV6()).cliHelp('dns-server ')).toContain('X:X:X:X::X');
    });

  it('et `?` decrit chaque commande avec les mots de SON mode', async () => {
    expect((await dansUnPool(PLATEFORMES[0][1])).cliHelp(''))
      .toContain('Set DNS server for DHCP clients');
    const v6 = (await dansLePoolV6()).cliHelp('');
    expect(v6).toContain('IPv6 DNS server');
    expect(v6).not.toContain('Set DNS server for DHCP clients');
  });

  it('les deux acceptent leur propre adresse', async () => {
    expect(await (await dansUnPool(PLATEFORMES[0][1]))
      .executeCommand('dns-server 8.8.8.8')).not.toContain('Invalid input');
    expect(await (await dansLePoolV6())
      .executeCommand('dns-server 2001:4860:4860::8888')).not.toContain('Invalid input');
  });

  it('le sous-mode classe garde SA plage d\'adresses', async () => {
    const device = await dansUnPool(PLATEFORMES[0][1]);
    await device.executeCommand('class VOIP');
    expect(await device.executeCommand('address range 10.0.0.10 10.0.0.20'))
      .not.toContain('Invalid input');
    expect(device.cliHelp('address ')).toContain('range');
  });
});

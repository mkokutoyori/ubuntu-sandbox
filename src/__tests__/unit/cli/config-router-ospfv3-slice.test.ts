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

async function dansOspfv3(): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', 'ipv6 unicast-routing',
    'ipv6 router ospf 1']) {
    await device.executeCommand(c);
  }
  return device;
}

async function dansOspfv2(): Promise<Cli> {
  const device = nu();
  for (const c of ['enable', 'configure terminal', 'router ospf 1']) {
    await device.executeCommand(c);
  }
  return device;
}

describe('l\'arbre du sous-mode `config-router-ospfv3` est VIDE', () => {
  it('zero chemin', () => {
    const shell = (nu() as unknown as { shell: Record<string, unknown> }).shell;
    expect((shell.configRouterOspfv3Trie as CommandTrie).enumerateExecutablePaths())
      .toEqual([]);
  });
});

const REGLAGES = [
  'router-id 1.1.1.1',
  'passive-interface GigabitEthernet0/0',
  'passive-interface default',
  'area 1 stub',
  'area 0.0.0.1 range 2001:db8::/64',
  'area 1 virtual-link 2.2.2.2',
  'redistribute static',
  'default-information originate',
  'default-information originate always',
  'graceful-restart',
  'graceful-restart grace-period 240',
  'bfd all-interfaces',
  'distribute-list prefix-list FOO in',
];

describe('les treize reglages sont acceptes', () => {
  it.each(REGLAGES)('`%s`', async (commande) => {
    expect(await (await dansOspfv3()).executeCommand(commande))
      .not.toContain('Invalid input');
  });
});

describe('la negation atteint le gestionnaire de SA commande', () => {
  it('`no passive-interface` rend vraiment l\'interface active', async () => {
    const device = await dansOspfv3();
    await device.executeCommand('passive-interface GigabitEthernet0/0');
    expect(await device.executeCommand('no passive-interface GigabitEthernet0/0'))
      .not.toContain('Invalid input');
  });

  it('`no passive-interface default` passe par le meme chemin', async () => {
    const device = await dansOspfv3();
    await device.executeCommand('passive-interface default');
    expect(await device.executeCommand('no passive-interface default'))
      .not.toContain('Invalid input');
  });
});

describe('`area` prend son numero AVANT son mot-cle', () => {
  it('`area ?` annonce le numero, pas `stub`', async () => {
    const aide = (await dansOspfv3()).cliHelp('area ');
    expect(aide).toContain('<0-4294967295>');
    expect(aide).not.toContain('stub');
  });

  it('`area 1 ?` annonce les trois familles', async () => {
    const aide = (await dansOspfv3()).cliHelp('area 1 ');
    for (const mot of ['range', 'stub', 'virtual-link']) expect(aide).toContain(mot);
  });

  it('`area 1 range ?` annonce un prefixe IPv6, pas un masque IPv4', async () => {
    const aide = (await dansOspfv3()).cliHelp('area 1 range ');
    expect(aide).toContain('X:X:X:X::X/<0-128>');
  });

  it('`area 0 stub` reste refuse — la dorsale n\'est pas une aire terminale', async () => {
    expect(await (await dansOspfv3()).executeCommand('area 0 stub'))
      .toContain('backbone area');
  });

  it('la tabulation garde le numero deja tape', async () => {
    expect((await dansOspfv3()).cliTabCandidates('area 1 vir'))
      .toEqual(['area 1 virtual-link']);
  });
});

describe('`distribute-list` nomme sa liste et son sens', () => {
  it('`distribute-list ?` annonce `prefix-list`', async () => {
    expect((await dansOspfv3()).cliHelp('distribute-list '))
      .toContain('prefix-list');
  });

  it('`distribute-list prefix-list FOO ?` annonce les deux sens', async () => {
    const aide = (await dansOspfv3()).cliHelp('distribute-list prefix-list FOO ');
    expect(aide).toContain('in');
    expect(aide).toContain('out');
  });

  it('un sens qui n\'existe pas est refuse au caret', async () => {
    expect(await (await dansOspfv3()).executeCommand('distribute-list prefix-list FOO sideways'))
      .toContain('Invalid input detected');
  });
});

describe('`?` decrit la commande de SON mode, jamais celle du voisin', () => {
  it('`redistribute ?` n\'offre que ce que OSPFv3 honore', async () => {
    const aide = (await dansOspfv3()).cliHelp('redistribute ');
    expect(aide).toContain('static');
    expect(aide).not.toContain('bgp');
  });

  it('OSPFv2 garde ses cinq protocoles au meme endroit', async () => {
    const aide = (await dansOspfv2()).cliHelp('redistribute ');
    for (const mot of ['bgp', 'connected', 'eigrp', 'rip', 'static']) {
      expect(aide, mot).toContain(mot);
    }
  });

  it('`area` se decrit avec les mots de OSPFv3', async () => {
    expect((await dansOspfv3()).cliHelp('')).toContain('OSPFv3 area parameters');
  });

  it('`area` se decrit avec les mots de OSPFv2 dans l\'autre mode', async () => {
    expect((await dansOspfv2()).cliHelp('')).toContain('OSPF area parameters');
  });

  it('`router-id ?` attend une adresse', async () => {
    expect((await dansOspfv3()).cliHelp('router-id ')).toContain('A.B.C.D');
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`router-i` se complete', async () => {
    expect((await dansOspfv3()).cliTabCandidates('router-i')).toEqual(['router-id']);
  });

  it('`graceful` se complete', async () => {
    expect((await dansOspfv3()).cliTabCandidates('graceful'))
      .toEqual(['graceful-restart']);
  });
});

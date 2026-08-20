import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
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
  executeCommand(command: string): Promise<string>;
  cliHelp(input: string): string;
  cliTabCandidates(input: string): string[];
}

let serial = 0;

function nu(): Cli {
  return new CiscoRouter(`R${serial++}`) as unknown as Cli;
}

async function privilegie(): Promise<Cli> {
  const device = nu();
  await device.executeCommand('enable');
  return device;
}

async function avecIpv6(): Promise<Cli> {
  const device = await privilegie();
  await device.executeCommand('configure terminal');
  await device.executeCommand('ipv6 unicast-routing');
  await device.executeCommand('interface GigabitEthernet0/0');
  await device.executeCommand('ipv6 address 2001:db8::1/64');
  await device.executeCommand('no shutdown');
  await device.executeCommand('end');
  return device;
}

const VUES = [
  'show ipv6 interface',
  'show ipv6 interface brief',
  'show ipv6 traffic',
  'show ipv6 static',
  'show ipv6 neighbors',
  'show ipv6 ospf',
  'show ipv6 protocols',
  'show ipv6 route',
  'show ipv6 eigrp neighbors',
  'show ipv6 dhcp binding',
  'show ipv6 dhcp pool',
  'show ipv6 dhcp interface',
];

describe('les douze vues restent au niveau 1', () => {
  it.each(VUES)('`%s` repond en EXEC utilisateur', async (command) => {
    expect(await nu().executeCommand(command)).not.toContain('Invalid input');
  });
});

describe('une machine sans IPv6 rend ce qu\'elle rendait', () => {
  it('`show ipv6 ospf` dit que le processus n\'est pas configure', async () => {
    expect(await nu().executeCommand('show ipv6 ospf'))
      .toContain('% OSPFv3 is not configured');
  });

  it('`show ipv6 dhcp pool` le dit en toutes lettres', async () => {
    expect(await nu().executeCommand('show ipv6 dhcp pool'))
      .toBe('No IPv6 DHCP pools configured.');
  });

  it('`show ipv6 eigrp neighbors` se TAIT', async () => {
    expect(await nu().executeCommand('show ipv6 eigrp neighbors')).toBe('');
  });

  it('`show ipv6 route` rend son en-tete', async () => {
    expect(await nu().executeCommand('show ipv6 route')).toContain('IPv6 Routing Table');
  });
});

describe('les vues lisent l\'etat, et l\'argument SELECTIONNE', () => {
  it('`show ipv6 interface` sans argument rend le resume', async () => {
    expect(await (await avecIpv6()).executeCommand('show ipv6 interface'))
      .toContain('GigabitEthernet0/0');
  });

  it('`show ipv6 interface <nom>` rend le detail de CETTE interface', async () => {
    const rendu = await (await avecIpv6())
      .executeCommand('show ipv6 interface GigabitEthernet0/0');
    expect(rendu).toContain('GigabitEthernet0/0');
    expect(rendu).toContain('2001:db8::1/64');
  });

  it('un nom abrege designe la meme interface', async () => {
    const device = await avecIpv6();
    expect(await device.executeCommand('show ipv6 interface Gi0/0'))
      .toBe(await device.executeCommand('show ipv6 interface GigabitEthernet0/0'));
  });

  it('une interface inconnue est refusee au caret', async () => {
    expect(await (await avecIpv6()).executeCommand('show ipv6 interface Zorglub9'))
      .toContain('% Invalid input');
  });

  it('`show ipv6 route static` filtre par protocole', async () => {
    expect(await (await avecIpv6()).executeCommand('show ipv6 route static'))
      .not.toContain('Invalid input');
  });
});

describe('`?` decrit la place par ce qu\'il faut y taper', () => {
  it('`show ipv6 interface ?` annonce l\'interface ET `brief`', async () => {
    const aide = (await privilegie()).cliHelp('show ipv6 interface ');
    expect(aide).toContain('Interface name');
    expect(aide).toContain('brief');
  });

  it('`show ipv6 neighbors ?` annonce l\'interface', async () => {
    const aide = (await privilegie()).cliHelp('show ipv6 neighbors ');
    expect(aide).toContain('Interface name');
    expect(aide).not.toContain('Display IPv6 neighbour cache');
  });

  it('`show ipv6 ospf ?` annonce la plage du numero de processus', async () => {
    expect((await privilegie()).cliHelp('show ipv6 ospf ')).toContain('<1-65535>');
  });

  it('`show ipv6 route ?` annonce ce que la place accepte', async () => {
    expect((await privilegie()).cliHelp('show ipv6 route ')).toContain('Prefix or protocol');
  });
});

describe('un noeud de branche garde son propre nom', () => {
  it.each([
    ['dhcp', 'Dynamic Host Configuration Protocol'],
    ['eigrp', 'Enhanced Interior Gateway Routing Protocol'],
  ])('`show ipv6 ?` decrit `%s`', async (mot, libelle) => {
    const ligne = (await privilegie()).cliHelp('show ipv6 ')
      .split('\n').find((l) => l.trim().startsWith(mot))!;
    expect(ligne).toContain(libelle);
  });
});

describe('la tabulation complete ce que l\'aide propose', () => {
  it('`show ipv6 nei` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ipv6 nei'))
      .toEqual(['show ipv6 neighbors']);
  });

  it('`show ipv6 dhcp bin` se complete', async () => {
    expect((await privilegie()).cliTabCandidates('show ipv6 dhcp bin'))
      .toEqual(['show ipv6 dhcp binding']);
  });
});

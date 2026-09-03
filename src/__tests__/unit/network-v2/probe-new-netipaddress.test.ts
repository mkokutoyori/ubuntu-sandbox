/**
 * `New-NetIPAddress` — les seize parametres de la commande, ses deux jeux
 * de parametres, et l'objet qu'elle rend.
 *
 * Sources. La syntaxe, les deux jeux (`ByInterfaceAlias` par defaut et
 * `ByInterfaceIndex`), la position 0 d'`-IPAddress`, les valeurs admises
 * de `-AddressFamily`/`-Type`/`-PolicyStore`, le type `Byte` de
 * `-PrefixLength` et la sortie `MSFT_NetIPAddress` viennent de la page de
 * la commande (`MicrosoftDocs/windows-powershell-docs`,
 * `NetTCPIP/New-NetIPAddress.md`). La desactivation automatique de DHCP
 * est ecrite dans la DESCRIPTION de cette meme page : « If you run this
 * cmdlet to add an IP address to an interface on which DHCP is already
 * enabled, then DHCP is automatically disabled. » L'EXEMPLE 1 de la page
 * emploie `-InterfaceIndex`, forme qui etait refusee.
 *
 * Le moteur HISTORIQUE (`PSNetCmdlets.handleNewNetIPAddress`) portait une
 * SECONDE implantation de la meme commande, et les deux ne s'accordaient
 * sur presque rien — le prefixe absent, l'adresse invalide, le doublon, la
 * sortie. Elle est supprimee : deux cas de STRUCTURE l'epinglent, avec la
 * forme de l'entree d'adresse, qui etait declaree TROIS fois.
 *
 * Discrimine par `git stash` : 16 cas tombent avant correctif. Les 4
 * autres sont nommes ici plutot que laisses a decouvrir :
 *   - « une adresse ordinaire » est le TEMOIN — la commande posait deja
 *     l'adresse, et sans lui une implantation qui refuserait TOUT
 *     passerait une sonde faite seulement de refus ;
 *   - « une adresse invalide est refusee » et « un doublon est refuse »
 *     etaient deja justes, `addIPAddress` les gardant depuis un lot
 *     anterieur ;
 *   - « l'adresse arrive jusqu'a ipconfig » passait deja, et il est ici
 *     parce que c'est la propriete que la suppression du DOUBLON ne
 *     devait pas casser.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

type Shell = ReturnType<typeof PowerShellSubShell.create>['subShell'];
const shellOf = (pc: WindowsPC): Shell => PowerShellSubShell.create(pc).subShell;
const run = async (sh: Shell, line: string) => (await sh.processLine(line)).output.join('\n').trim();

function machine(): { pc: WindowsPC; sh: Shell } {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.powerOn();
  return { pc, sh: shellOf(pc) };
}

const addresses = async (sh: Shell) => run(sh, 'Get-NetIPAddress | Format-Table IPAddress,InterfaceAlias,PrefixLength');

describe('New-NetIPAddress — l adresse et l interface', () => {
  it('TEMOIN : une adresse ordinaire est posee sur le vrai port', async () => {
    const { pc, sh } = machine();
    await run(sh, 'New-NetIPAddress -IPAddress 192.168.50.10 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    expect(pc.getPort('eth0')!.getIPAddress()?.toString()).toBe('192.168.50.10');
  });

  it('TEMOIN : l adresse arrive jusqu a ipconfig', async () => {
    const { pc, sh } = machine();
    await run(sh, 'New-NetIPAddress -IPAddress 192.168.50.11 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    expect(await pc.executeCommand('ipconfig')).toContain('192.168.50.11');
  });

  it('accepte -IPAddress en position 0', async () => {
    const { pc, sh } = machine();
    expect(await run(sh, 'New-NetIPAddress 10.1.1.1 -InterfaceAlias "Ethernet 0" -PrefixLength 24'))
      .toContain('10.1.1.1');
    expect(pc.getPort('eth0')!.getIPAddress()?.toString()).toBe('10.1.1.1');
  });

  it('accepte -InterfaceIndex, le second jeu de parametres', async () => {
    const { pc, sh } = machine();
    const out = await run(sh, 'New-NetIPAddress -InterfaceIndex 1 -IPAddress 192.168.0.1 -PrefixLength 24 -DefaultGateway 192.168.0.5');
    expect(out).toContain('192.168.0.1');
    expect(pc.getPort('eth0')!.getIPAddress()?.toString()).toBe('192.168.0.1');
  });

  it('refuse une interface qui n existe pas, par alias comme par index', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.5.5.5 -InterfaceAlias "Zorglub" -PrefixLength 24'))
      .toContain('No matching interface found.');
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.5.5.6 -InterfaceIndex 99 -PrefixLength 24'))
      .toContain('No matching interface found.');
    expect(await addresses(sh)).not.toContain('10.5.5.');
  });

  it('exige une interface', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.6.6.6 -PrefixLength 24'))
      .toContain('missing mandatory parameters');
  });
});

describe('New-NetIPAddress — ce qui est refuse', () => {
  it('TEMOIN : une adresse invalide est refusee', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 999.999.999.999 -InterfaceAlias "Ethernet 0" -PrefixLength 24'))
      .toContain("Cannot validate argument on parameter 'IPAddress'");
  });

  it('TEMOIN : une adresse deja posee est refusee', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetIPAddress -IPAddress 10.7.7.7 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.7.7.7 -InterfaceAlias "Ethernet 0" -PrefixLength 24'))
      .toContain('already exists');
  });

  it('un prefixe hors de la plage de la famille est refuse', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.4.4.4 -InterfaceAlias "Ethernet 0" -PrefixLength 33'))
      .toContain('The prefix length 33 is not valid for an IPv4 address.');
    expect(await run(sh, 'New-NetIPAddress -IPAddress 2001:db8::9 -InterfaceAlias "Ethernet 0" -PrefixLength 129'))
      .toContain('The prefix length 129 is not valid for an IPv6 address.');
    expect(await addresses(sh)).not.toContain('10.4.4.4');
  });

  it('un prefixe qui n est pas un octet est refuse dans les mots de PowerShell', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.4.4.5 -InterfaceAlias "Ethernet 0" -PrefixLength 300'))
      .toContain('System.Byte');
  });

  it('une famille declaree qui contredit l adresse est refusee', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.8.8.8 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -AddressFamily IPv6'))
      .toContain("Cannot validate argument on parameter 'AddressFamily'");
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.8.8.8 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -AddressFamily Zorglub'))
      .toContain("Cannot validate argument on parameter 'AddressFamily'");
  });

  it('un -Type et un -PolicyStore hors des valeurs admises sont refuses', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.9.9.9 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -Type Zorglub'))
      .toContain("Cannot validate argument on parameter 'Type'");
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.9.9.9 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -PolicyStore Zorglub'))
      .toContain("Cannot validate argument on parameter 'PolicyStore'");
  });

  it('une passerelle malformee, ou d une autre famille, est refusee', async () => {
    const { sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.10.10.10 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -DefaultGateway 300.1.1.1'))
      .toContain("Cannot validate argument on parameter 'DefaultGateway'");
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.10.10.10 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -DefaultGateway 2001:db8::1'))
      .toContain("Cannot validate argument on parameter 'DefaultGateway'");
  });
});

describe('New-NetIPAddress — ce qu elle rend et ce qu elle retient', () => {
  it('rend l objet MSFT_NetIPAddress de l adresse creee', async () => {
    const { sh } = machine();
    const out = await run(sh, 'New-NetIPAddress -IPAddress 10.11.11.11 -InterfaceAlias "Ethernet 0" -PrefixLength 25 -Type Anycast -SkipAsSource $true | Format-List *');
    expect(out).toContain('IPAddress         : 10.11.11.11');
    expect(out).toContain('InterfaceAlias    : Ethernet 0');
    expect(out).toContain('PrefixLength      : 25');
    expect(out).toContain('Type              : Anycast');
    expect(out).toContain('SkipAsSource      : True');
    expect(out).toContain('PrefixOrigin      : Manual');
  });

  it('-SkipAsSource est retenu et relu par Get-NetIPAddress', async () => {
    const { sh } = machine();
    await run(sh, 'New-NetIPAddress -IPAddress 10.12.12.12 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -SkipAsSource $true');
    expect(await run(sh, 'Get-NetIPAddress | Where-Object { $_.IPAddress -eq "10.12.12.12" } | Format-List SkipAsSource'))
      .toContain('True');
  });

  it('-WhatIf annonce sans rien poser', async () => {
    const { pc, sh } = machine();
    expect(await run(sh, 'New-NetIPAddress -IPAddress 10.13.13.13 -InterfaceAlias "Ethernet 0" -PrefixLength 24 -WhatIf'))
      .toContain('What if:');
    expect(await addresses(sh)).not.toContain('10.13.13.13');
    expect(pc.getPort('eth0')!.getIPAddress()).toBeNull();
  });

  it('une adresse IPv6 est posee avec sa famille et son prefixe', async () => {
    const { sh } = machine();
    const out = await run(sh, 'New-NetIPAddress -IPAddress 2001:db8::5 -InterfaceAlias "Ethernet 0" -PrefixLength 64');
    expect(out).toContain('2001:db8::5');
    expect(await run(sh, 'Get-NetIPAddress -AddressFamily IPv6 | Format-Table IPAddress,PrefixLength'))
      .toContain('2001:db8::5');
  });
});

describe('New-NetIPAddress — une seule source de verite', () => {
  it('le moteur historique ne porte plus de New-NetIPAddress a lui', () => {
    const legacy = readFileSync('src/network/devices/windows/PSNetCmdlets.ts', 'utf8');
    expect(legacy).not.toContain('handleNewNetIPAddress');
    const executor = readFileSync('src/network/devices/windows/PowerShellExecutor.ts', 'utf8');
    expect(executor).not.toContain('handleNewNetIPAddress');
  });

  it('la forme de l entree d adresse est declaree une seule fois', () => {
    const shape = /prefixOrigin: string; suffixOrigin: string; skipAsSource: boolean/g;
    for (const f of ['src/network/devices/WindowsPC.ts',
                     'src/powershell/providers/WindowsPSProviders.ts',
                     'src/network/devices/windows/PowerShellExecutor.ts']) {
      expect(readFileSync(f, 'utf8').match(shape)).toBeNull();
    }
    expect(readFileSync('src/network/devices/windows/netIpAddress.ts', 'utf8'))
      .toContain('export interface NetIPAddressEntry');
  });
});

describe('New-NetIPAddress — DHCP', () => {
  async function dhcpServer(network: string): Promise<CiscoRouter> {
    const srv = new CiscoRouter('SRV', 0, 0);
    for (const c of ['enable', 'configure terminal',
      'interface GigabitEthernet0/0', `ip address ${network}.1 255.255.255.0`, 'no shutdown', 'exit',
      `ip dhcp excluded-address ${network}.1`,
      'ip dhcp pool LAN', `network ${network}.0 255.255.255.0`, `default-router ${network}.1`, 'exit', 'end',
    ]) await srv.executeCommand(c);
    return srv;
  }

  it('poser une adresse statique DESACTIVE le DHCP de l interface, et Get-NetIPInterface le voit', async () => {
    const srv = await dhcpServer('10.40.9');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
    pc.powerOn();
    new Cable('c-srv').connect(srv.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-pc').connect(pc.getPorts()[0], sw.getPorts()[1]);

    await pc.executeCommand('ipconfig /renew');
    expect(pc.getPorts()[0].getIPAddress()?.toString()).toMatch(/^10\.40\.9\./);

    const sh = shellOf(pc);
    expect(await run(sh, 'Get-NetIPInterface -InterfaceAlias "Ethernet 0" | Format-List Dhcp')).toContain('Enabled');

    await run(sh, 'New-NetIPAddress -IPAddress 10.40.9.200 -InterfaceAlias "Ethernet 0" -PrefixLength 24');
    expect(await run(sh, 'Get-NetIPInterface -InterfaceAlias "Ethernet 0" | Format-List Dhcp')).toContain('Disabled');
  });
});

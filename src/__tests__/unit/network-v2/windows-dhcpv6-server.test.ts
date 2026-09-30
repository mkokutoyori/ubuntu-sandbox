/*
 * Windows Server, role DHCP, DHCPv6 (RFC 8415) : Add-DhcpServerv6Scope,
 * Get/Set/Remove-DhcpServerv6Scope, Add/Get-DhcpServerv6ExclusionRange,
 * Add/Get/Remove-DhcpServerv6Reservation, Set/Get-DhcpServerv6OptionValue,
 * Get/Remove-DhcpServerv6Lease, servis sur UDP 547 par le moteur DHCPv6 commun
 * (Dhcpv6HostService) : de vraies trames SOLICIT/ADVERTISE/REQUEST/REPLY entre un
 * client Linux et le serveur, le multicast ff02::1:2 etant rejoint par le role.
 * Noms et parametres des cmdlets : documentation Microsoft du module DhcpServer ;
 * les messages d'erreur exacts et le detail des proprietes de sortie ne sont
 * pas verifies (page non joignable depuis cet environnement).
 *
 * Avant le correctif : aucune de ces cmdlets n'existait (« not recognized »), le
 * role n'ecoutait pas le port 547 et le serveur Windows ne servait aucun bail
 * DHCPv6 : les 22 cas tombent, sauf le temoin « les cmdlets v4 sont
 * inchangees » qui passe.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, IPv6Address, SubnetMask } from '@/network/core/types';
import { ipv6ToBigInt } from '@/network/core/Ipv6Arithmetic';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function lan() {
  const dhcp = new WindowsServer('DHCP1');
  const c1 = new LinuxPC('linux-pc', 'C1');
  const c2 = new LinuxPC('linux-pc', 'C2');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('a').connect(dhcp.getPorts()[0], sw.getPorts()[0]);
  new Cable('b').connect(c1.getPorts()[0], sw.getPorts()[1]);
  new Cable('c').connect(c2.getPorts()[0], sw.getPorts()[2]);
  dhcp.getPorts()[0].configureIP(new IPAddress('192.168.80.10'), new SubnetMask('255.255.255.0'));
  dhcp.getPorts()[0].enableIPv6();
  dhcp.getPorts()[0].configureIPv6(new IPv6Address('2001:db8:1::10'), 64);
  dhcp.setCurrentUser('Administrator');
  const shell = ps(dhcp);
  await run(shell, 'Install-WindowsFeature DHCP');
  return { dhcp, c1, c2, shell };
}

async function withScope() {
  const l = await lan();
  await run(l.shell, 'Add-DhcpServerv6Scope -Prefix 2001:db8:1:: -Name LAN6');
  return l;
}

describe('temoin', () => {
  it('les cmdlets v4 sont inchangees', async () => {
    const { shell } = await lan();
    await run(shell, 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    expect(await run(shell, 'Get-DhcpServerv4Scope')).toContain('LAN');
  });
});

describe('cmdlets sans role', () => {
  it('Add-DhcpServerv6Scope est inconnue avant Install-WindowsFeature DHCP', async () => {
    const dhcp = new WindowsServer('DHCP9');
    dhcp.setCurrentUser('Administrator');
    expect(await run(ps(dhcp), 'Add-DhcpServerv6Scope -Prefix 2001:db8:1:: -Name X')).toMatch(/not recognized/i);
  });
});

describe('Add/Get/Set/Remove-DhcpServerv6Scope', () => {
  it('cree un scope avec les durees par defaut de Windows : 8 j / 12 j, T1 4 j, T2 6,4 j', async () => {
    const { shell } = await withScope();
    const out = await run(shell, 'Get-DhcpServerv6Scope | Format-List Prefix, Name, State, PreferredLifetime, ValidLifetime, T1, T2, Preference');
    expect(out).toContain('2001:db8:1::');
    expect(out).toContain('LAN6');
    expect(out).toContain('Active');
    expect(out).toMatch(/PreferredLifetime\s*:\s*8\.00:00:00/);
    expect(out).toMatch(/ValidLifetime\s*:\s*12\.00:00:00/);
    expect(out).toMatch(/T1\s*:\s*4\.00:00:00/);
    expect(out).toMatch(/T2\s*:\s*6\.09:36:00/);
  });

  it('refuse un doublon de prefixe', async () => {
    const { shell } = await withScope();
    expect(await run(shell, 'Add-DhcpServerv6Scope -Prefix 2001:db8:1:: -Name AUTRE')).toMatch(/already exists/i);
  });

  it('refuse des durees incoherentes (preferee > valide)', async () => {
    const { shell } = await lan();
    const out = await run(shell, 'Add-DhcpServerv6Scope -Prefix 2001:db8:2:: -Name BAD -PreferredLifetime "10.00:00:00" -ValidLifetime "1.00:00:00"');
    expect(out).toMatch(/preferred lifetime must not exceed/i);
  });

  it('Set-DhcpServerv6Scope modifie les durees et l etat, Remove-DhcpServerv6Scope le supprime', async () => {
    const { shell, dhcp } = await withScope();
    await run(shell, 'Set-DhcpServerv6Scope -Prefix 2001:db8:1:: -PreferredLifetime "1.00:00:00" -ValidLifetime "2.00:00:00"');
    const pool = dhcp.getDhcpServerRole()!.v6.engine().getPool('2001:db8:1::/64')!;
    expect([pool.preferredLifetime, pool.validLifetime, pool.t1, pool.t2]).toEqual([86400, 172800, 43200, 69120]);
    await run(shell, 'Remove-DhcpServerv6Scope -Prefix 2001:db8:1::');
    expect(await run(shell, 'Get-DhcpServerv6Scope')).not.toContain('LAN6');
  });

  it('un scope InActive ne sert plus', async () => {
    const { shell, c1, dhcp } = await withScope();
    await run(shell, 'Set-DhcpServerv6Scope -Prefix 2001:db8:1:: -State InActive');
    c1.requestDhcpv6Lease('eth0', true);
    expect(dhcp.getDhcpServerRole()!.v6.getLeases()).toEqual([]);
  });
});

describe('bail DHCPv6 sur le fil', () => {
  it('un client Linux obtient une adresse du prefixe du scope', async () => {
    const { c1, shell } = await withScope();
    const out = await c1.executeCommand('dhclient -6 -v eth0');
    expect(out).toContain('DHCPv6 REPLY');
    expect(await run(shell, 'Get-DhcpServerv6Lease')).toContain('2001:db8:1:');
    expect(c1.getDhcpv6Lease('eth0')?.address).toMatch(/^2001:db8:1:/);
  });

  it('deux clients recoivent deux adresses distinctes', async () => {
    const { c1, c2 } = await withScope();
    await c1.executeCommand('dhclient -6 eth0');
    await c2.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')?.address).not.toBe(c2.getDhcpv6Lease('eth0')?.address);
  });

  it('la duree valide du scope se retrouve dans le bail cote client', async () => {
    const { c1, shell } = await withScope();
    await run(shell, 'Set-DhcpServerv6Scope -Prefix 2001:db8:1:: -PreferredLifetime "1.00:00:00" -ValidLifetime "2.00:00:00"');
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')).toMatchObject({ preferredLifetime: 86400, validLifetime: 172800, t1: 43200, t2: 69120 });
  });

  it('Renew, Release et Decline passent par le serveur Windows', async () => {
    const { c1, dhcp } = await withScope();
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.renewDhcpv6Lease('eth0')).toBe('extended');
    expect(c1.releaseDhcpv6Lease('eth0')).toBe(true);
    expect(dhcp.getDhcpServerRole()!.v6.getLeases()).toEqual([]);
  });

  it('Rapid Commit non configure sur le serveur Windows : le client fait quand meme quatre messages', async () => {
    const { c1 } = await withScope();
    const out = c1.requestDhcpv6Lease('eth0', true, { rapidCommit: true });
    expect(out).toContain('DHCPv6 REQUEST');
  });

  it('Get-DhcpServerv6Lease -Prefix filtre ; Remove-DhcpServerv6Lease efface', async () => {
    const { c1, shell } = await withScope();
    await run(shell, 'Add-DhcpServerv6Scope -Prefix 2001:db8:9:: -Name AUTRE');
    await c1.executeCommand('dhclient -6 eth0');
    const address = c1.getDhcpv6Lease('eth0')!.address!;
    expect(await run(shell, 'Get-DhcpServerv6Lease -Prefix 2001:db8:9::')).not.toContain(address);
    expect(await run(shell, 'Get-DhcpServerv6Lease -Prefix 2001:db8:1::')).toContain(address);
    await run(shell, `Remove-DhcpServerv6Lease -IPAddress ${address}`);
    expect(await run(shell, 'Get-DhcpServerv6Lease')).not.toContain(address);
  });
});

describe('exclusions et reservations', () => {
  it('une exclusion retire ses adresses du pool', async () => {
    const { c1, shell } = await withScope();
    await run(shell, 'Add-DhcpServerv6ExclusionRange -Prefix 2001:db8:1:: -StartRange 2001:db8:1::2 -EndRange 2001:db8:1::ffff');
    expect(await run(shell, 'Get-DhcpServerv6ExclusionRange -Prefix 2001:db8:1::')).toContain('2001:db8:1::ffff');
    await c1.executeCommand('dhclient -6 eth0');
    const last = ipv6ToBigInt(new IPv6Address(c1.getDhcpv6Lease('eth0')!.address!));
    expect((last & 0xffffffffffffffffn) > 0xffffn).toBe(true);
  });

  it('une reservation par DUID donne toujours la meme adresse', async () => {
    const { c1, shell } = await withScope();
    const duid = `"00-03-00-01-${c1.getPorts()[0].getMAC().toString().replace(/:/g, '-')}"`;
    await run(shell, `Add-DhcpServerv6Reservation -Prefix 2001:db8:1:: -IPAddress 2001:db8:1::abcd -ClientDuid ${duid} -Iaid 1 -Name c1`);
    await c1.executeCommand('dhclient -6 eth0');
    expect(c1.getDhcpv6Lease('eth0')?.address).toBe('2001:db8:1::abcd');
    expect(await run(shell, 'Get-DhcpServerv6Reservation -Prefix 2001:db8:1::')).toContain('2001:db8:1::abcd');
  });

  it('l adresse reservee n est pas donnee a un autre client', async () => {
    const { c1, c2, shell } = await withScope();
    const duid = `"00-03-00-01-${c1.getPorts()[0].getMAC().toString().replace(/:/g, '-')}"`;
    await run(shell, `Add-DhcpServerv6Reservation -Prefix 2001:db8:1:: -IPAddress 2001:db8:1::2 -ClientDuid ${duid} -Iaid 1`);
    await c2.executeCommand('dhclient -6 eth0');
    expect(c2.getDhcpv6Lease('eth0')?.address).not.toBe('2001:db8:1::2');
  });

  it('reservation hors du prefixe refusee, DUID invalide refuse', async () => {
    const { shell } = await withScope();
    expect(await run(shell, 'Add-DhcpServerv6Reservation -Prefix 2001:db8:1:: -IPAddress 2001:db8:7::2 -ClientDuid "00-03-00-01-aa-bb-cc-dd-ee-ff" -Iaid 1')).toMatch(/outside the scope/i);
    expect(await run(shell, 'Add-DhcpServerv6Reservation -Prefix 2001:db8:1:: -IPAddress 2001:db8:1::5 -ClientDuid zzzz -Iaid 1')).toMatch(/not a valid DUID/i);
  });

  it('Remove-DhcpServerv6Reservation', async () => {
    const { shell } = await withScope();
    await run(shell, 'Add-DhcpServerv6Reservation -Prefix 2001:db8:1:: -IPAddress 2001:db8:1::5 -ClientDuid "00-03-00-01-aa-bb-cc-dd-ee-ff" -Iaid 1');
    await run(shell, 'Remove-DhcpServerv6Reservation -Prefix 2001:db8:1:: -IPAddress 2001:db8:1::5');
    expect(await run(shell, 'Get-DhcpServerv6Reservation -Prefix 2001:db8:1::')).not.toContain('2001:db8:1::5');
  });
});

describe('options DNS et liste de recherche', () => {
  it('Set-DhcpServerv6OptionValue sur le scope : le client recoit DNS et domaine', async () => {
    const { c1, shell } = await withScope();
    await run(shell, 'Set-DhcpServerv6OptionValue -Prefix 2001:db8:1:: -DnsServer 2001:db8:53::1 -DomainSearchList corp.local');
    await c1.executeCommand('dhclient -6 eth0');
    expect(await c1.executeCommand('cat /etc/resolv.conf')).toContain('2001:db8:53::1');
    expect(await run(shell, 'Get-DhcpServerv6OptionValue -Prefix 2001:db8:1::')).toContain('2001:db8:53::1');
  });

  it('option au niveau serveur : herite par les scopes qui n en definissent pas', async () => {
    const { c1, shell } = await withScope();
    await run(shell, 'Set-DhcpServerv6OptionValue -DnsServer 2001:db8:53::2');
    await c1.executeCommand('dhclient -6 eth0');
    expect(await c1.executeCommand('cat /etc/resolv.conf')).toContain('2001:db8:53::2');
  });

  it('adresse DNS invalide refusee, option non geree refusee', async () => {
    const { shell } = await withScope();
    expect(await run(shell, 'Set-DhcpServerv6OptionValue -DnsServer notanaddress')).toMatch(/not a valid IPv6/i);
    expect(await run(shell, 'Set-DhcpServerv6OptionValue -OptionId 99 -Value x')).toMatch(/not supported/i);
  });
});

describe('arret du role', () => {
  it('service arrete : plus aucune reponse', async () => {
    const { c1, dhcp } = await withScope();
    dhcp.getDhcpServerRole()!.stop();
    c1.requestDhcpv6Lease('eth0', true);
    expect(dhcp.getDhcpServerRole()!.v6.getLeases()).toEqual([]);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
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

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function labo() {
  const dhcp = new WindowsServer('DHCP1');
  const winClient = new WindowsPC('windows-pc', 'WIN1');
  const linuxClient = new LinuxPC('linux-pc', 'LNX1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(dhcp.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(winClient.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(linuxClient.getPorts()[0], sw.getPorts()[2]);
  dhcp.getPorts()[0].configureIP(new IPAddress('192.168.80.10'), new SubnetMask('255.255.255.0'));
  dhcp.setCurrentUser('Administrator');
  const sh = ps(dhcp);
  await run(sh, 'Install-WindowsFeature DHCP');
  await run(sh, 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.110 -SubnetMask 255.255.255.0');
  return { dhcp, winClient, linuxClient, sh };
}

describe('les reservations se lisent et se retirent', () => {
  it('`Get-DhcpServerv4Reservation` liste ce qui a ete reserve', async () => {
    const { winClient, sh } = await labo();
    const mac = winClient.getPorts()[0].getMAC().toString();
    await run(sh, `Add-DhcpServerv4Reservation -ScopeId LAN -IPAddress 192.168.80.105 -ClientId "${mac}"`);
    const out = await run(sh, 'Get-DhcpServerv4Reservation -ScopeId LAN');
    expect(out).toContain('192.168.80.105');
    expect(out.toLowerCase()).toContain(mac.replace(/:/g, '-').toLowerCase());
  });

  it('`Remove-DhcpServerv4Reservation` la retire, et le client reprend une adresse du pool', async () => {
    const { winClient, sh } = await labo();
    const mac = winClient.getPorts()[0].getMAC().toString();
    await run(sh, `Add-DhcpServerv4Reservation -ScopeId LAN -IPAddress 192.168.80.105 -ClientId "${mac}"`);
    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').lease?.ipAddress).toBe('192.168.80.105');

    await run(sh, 'Remove-DhcpServerv4Reservation -ScopeId LAN -IPAddress 192.168.80.105');
    expect(await run(sh, 'Get-DhcpServerv4Reservation -ScopeId LAN')).not.toContain('192.168.80.105');

    winClient.getDHCPClient().releaseLease('eth0');
    winClient.getDHCPClient().getState('eth0').lastKnownLease = null;
    winClient.getDHCPClient().requestLease('eth0');
    const ip = winClient.getDHCPClient().getState('eth0').lease?.ipAddress;
    expect(ip).not.toBe('192.168.80.105');
    expect(ip?.startsWith('192.168.80.1')).toBe(true);
  });
});

describe('le cycle de vie d\'une etendue', () => {
  it('`Set-DhcpServerv4Scope` change la duree de bail et le nom', async () => {
    const { sh } = await labo();
    await run(sh, 'Set-DhcpServerv4Scope -ScopeId LAN -Name LAN-BUREAU -LeaseDuration 3600');
    const out = await run(sh, 'Get-DhcpServerv4Scope');
    expect(out).toContain('LAN-BUREAU');
    expect(out).toContain('3600');
  });

  it('une etendue INACTIVE ne sert plus aucune adresse', async () => {
    const { winClient, sh } = await labo();
    await run(sh, 'Set-DhcpServerv4Scope -ScopeId LAN -State Inactive');
    expect(await run(sh, 'Get-DhcpServerv4Scope')).toContain('Inactive');

    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').lease?.ipAddress)
      .toMatch(/^169\.254\./);

    winClient.getDHCPClient().releaseLease('eth0');
    winClient.getDHCPClient().getState('eth0').lastKnownLease = null;
    await run(sh, 'Set-DhcpServerv4Scope -ScopeId LAN -State Active');
    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').lease?.ipAddress).toMatch(/^192\.168\.80\.1/);
  });

  it('`Remove-DhcpServerv4Scope` supprime l\'etendue et ce qu\'elle servait', async () => {
    const { winClient, sh } = await labo();
    await run(sh, 'Remove-DhcpServerv4Scope -ScopeId LAN');
    expect(await run(sh, 'Get-DhcpServerv4Scope')).not.toContain('LAN');
    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').lease?.ipAddress)
      .toMatch(/^169\.254\./);
  });
});

describe('les plages d\'exclusion se lisent, se retirent, et EXCLUENT', () => {
  it('une adresse exclue n\'est jamais attribuee', async () => {
    const { winClient, sh } = await labo();
    await run(sh, 'Add-DhcpServerv4ExclusionRange -ScopeId LAN -StartRange 192.168.80.100 -EndRange 192.168.80.104');
    winClient.getDHCPClient().requestLease('eth0');
    const ip = winClient.getDHCPClient().getState('eth0').lease?.ipAddress;
    expect(ip).toBeDefined();
    const dernier = Number(ip!.split('.')[3]);
    expect(dernier).toBeGreaterThan(104);
  });

  it('`Get-` puis `Remove-DhcpServerv4ExclusionRange` la rendent au pool', async () => {
    const { sh } = await labo();
    await run(sh, 'Add-DhcpServerv4ExclusionRange -ScopeId LAN -StartRange 192.168.80.100 -EndRange 192.168.80.104');
    expect(await run(sh, 'Get-DhcpServerv4ExclusionRange -ScopeId LAN')).toContain('192.168.80.104');
    await run(sh, 'Remove-DhcpServerv4ExclusionRange -ScopeId LAN -StartRange 192.168.80.100 -EndRange 192.168.80.104');
    expect(await run(sh, 'Get-DhcpServerv4ExclusionRange -ScopeId LAN')).not.toContain('192.168.80.104');
  });
});

describe('les options se lisent, se retirent, et l\'etendue herite du SERVEUR', () => {
  it('`Get-DhcpServerv4OptionValue` rend ce qui a ete pose', async () => {
    const { sh } = await labo();
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId LAN -Router 192.168.80.1 -DnsServer 8.8.8.8');
    const out = await run(sh, 'Get-DhcpServerv4OptionValue -ScopeId LAN');
    expect(out).toContain('192.168.80.1');
    expect(out).toContain('8.8.8.8');
  });

  it('`Remove-DhcpServerv4OptionValue` retire une option nommee', async () => {
    const { sh } = await labo();
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId LAN -Router 192.168.80.1 -DnsServer 8.8.8.8');
    await run(sh, 'Remove-DhcpServerv4OptionValue -ScopeId LAN -OptionId 6');
    const out = await run(sh, 'Get-DhcpServerv4OptionValue -ScopeId LAN');
    expect(out).toContain('192.168.80.1');
    expect(out).not.toContain('8.8.8.8');
  });

  it('une option posee au niveau SERVEUR est servie a une etendue qui n\'en a pas', async () => {
    const { winClient, sh } = await labo();
    await run(sh, 'Set-DhcpServerv4OptionValue -DnsServer 9.9.9.9');
    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').lease?.dnsServers).toContain('9.9.9.9');
  });

  it('l\'option de l\'etendue l\'emporte sur celle du serveur', async () => {
    const { winClient, sh } = await labo();
    await run(sh, 'Set-DhcpServerv4OptionValue -DnsServer 9.9.9.9');
    await run(sh, 'Set-DhcpServerv4OptionValue -ScopeId LAN -DnsServer 8.8.8.8');
    winClient.getDHCPClient().requestLease('eth0');
    const dns = winClient.getDHCPClient().getState('eth0').lease?.dnsServers ?? [];
    expect(dns).toContain('8.8.8.8');
    expect(dns).not.toContain('9.9.9.9');
  });
});

describe('les baux se revoquent, et se comptent', () => {
  it('`Remove-DhcpServerv4Lease` rend l\'adresse au pool', async () => {
    const { winClient, sh } = await labo();
    winClient.getDHCPClient().requestLease('eth0');
    const ip = winClient.getDHCPClient().getState('eth0').lease!.ipAddress;
    expect(await run(sh, 'Get-DhcpServerv4Lease -ScopeId LAN')).toContain(ip);

    await run(sh, `Remove-DhcpServerv4Lease -ScopeId LAN -IPAddress ${ip}`);
    expect(await run(sh, 'Get-DhcpServerv4Lease -ScopeId LAN')).not.toContain(ip);
  });

  it('`Get-DhcpServerv4ScopeStatistics` COMPTE ce qui est pris et ce qui reste', async () => {
    const { winClient, linuxClient, sh } = await labo();
    const vide = await run(sh, 'Get-DhcpServerv4ScopeStatistics -ScopeId LAN');
    expect(vide).toMatch(/\b11\b/);
    expect(vide).toMatch(/\b0\b/);

    winClient.getDHCPClient().requestLease('eth0');
    await linuxClient.executeCommand('sudo dhclient eth0');
    const apres = await run(sh, 'Get-DhcpServerv4ScopeStatistics -ScopeId LAN');
    expect(apres).toMatch(/\b2\b/);
  });

  it('`Get-DhcpServerv4Statistics` totalise le serveur', async () => {
    const { winClient, sh } = await labo();
    winClient.getDHCPClient().requestLease('eth0');
    const out = await run(sh, 'Get-DhcpServerv4Statistics');
    expect(out).toMatch(/Scopes/i);
    expect(out).toMatch(/\b1\b/);
  });
});

describe('l\'autorisation dans le domaine se lit et se retire', () => {
  it('`Get-DhcpServerInDC` liste le serveur autorise', async () => {
    const { dhcp, sh } = await labo();
    await run(sh, 'Add-DhcpServerInDC');
    const out = await run(sh, 'Get-DhcpServerInDC');
    expect(out).toContain('192.168.80.10');
    expect(out).toContain(dhcp.getHostname());
  });

  it('`Remove-DhcpServerInDC` retire l\'autorisation', async () => {
    const { sh } = await labo();
    await run(sh, 'Add-DhcpServerInDC');
    await run(sh, 'Remove-DhcpServerInDC');
    expect(await run(sh, 'Get-DhcpServerInDC')).not.toContain('192.168.80.10');
  });
});

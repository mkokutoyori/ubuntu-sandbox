import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

async function serveur(): Promise<{
  srv: WindowsServer; ps: (command: string) => Promise<string>;
}> {
  const srv = new WindowsServer('SRV-DHCP', 0, 0);
  const ps = (command: string) => srv.executeCommand(`powershell ${command}`);
  await ps('Install-WindowsFeature DHCP');
  return { srv, ps };
}

const ETENDUE = 'Add-DhcpServerv4Scope -Name "LAN-2" -StartRange 192.168.2.10'
  + ' -EndRange 192.168.2.200 -SubnetMask 255.255.255.0 -State Active';

describe('l\'etendue DHCP se declare avant ses options', () => {
  it('un serveur neuf n\'a AUCUNE etendue', async () => {
    const { ps } = await serveur();

    expect((await ps('Get-DhcpServerv4Scope')).trim()).toBe('');
  });

  it('`Add-DhcpServerv4Scope` derive le ScopeId du DEBUT de plage et du masque',
    async () => {
      const { ps } = await serveur();
      expect(await ps(ETENDUE)).toBe('');

      const vu = await ps('Get-DhcpServerv4Scope');
      expect(vu).toContain('192.168.2.0');
      expect(vu).toContain('255.255.255.0');
      expect(vu).toContain('LAN-2');
    });

  it('la passerelle n\'est PAS un identifiant d\'etendue', async () => {
    const { ps } = await serveur();
    await ps(ETENDUE);

    const vu = await ps('Set-DhcpServerv4OptionValue -ScopeId 192.168.2.1'
      + ' -Router 192.168.2.1 -DnsServer 4.4.4.4 -DnsDomain "domain.local"');

    expect(vu).toContain('192.168.2.1');
    expect(vu).toMatch(/does not exist/i);
  });

  it('le nom de la commande parait UNE fois, et bien orthographie', async () => {
    const { ps } = await serveur();
    await ps(ETENDUE);

    const vu = await ps('Set-DhcpServerv4OptionValue -ScopeId 192.168.2.1 -Router 1.1.1.1');

    expect(vu).toContain('Set-DhcpServerv4OptionValue : ');
    expect(vu).not.toContain('Set-Dhcpserverv4Optionvalue');
    expect(vu.match(/Set-DhcpServerv4OptionValue : /g)).toHaveLength(1);
    expect(vu).toContain('[Set-DhcpServerv4OptionValue]');
  });

  it('les options se posent sur le bon ScopeId et se relisent', async () => {
    const { ps } = await serveur();
    await ps(ETENDUE);

    expect(await ps('Set-DhcpServerv4OptionValue -ScopeId 192.168.2.0'
      + ' -Router 192.168.2.1 -DnsServer 4.4.4.4 -DnsDomain "domain.local"')).toBe('');

    const vu = await ps('Get-DhcpServerv4OptionValue -ScopeId 192.168.2.0');
    expect(vu).toContain('192.168.2.1');
    expect(vu).toContain('4.4.4.4');
    expect(vu).toContain('domain.local');
  });

  it('la continuation par accent grave est admise, comme dans la console',
    async () => {
      const { ps } = await serveur();
      const commande = [
        'Add-DhcpServerv4Scope `',
        '    -Name "LAN-3" `',
        '    -StartRange 192.168.3.10 `',
        '    -EndRange 192.168.3.200 `',
        '    -SubnetMask 255.255.255.0 `',
        '    -State Active',
      ].join('\n');

      expect(await ps(commande)).toBe('');
      expect(await ps('Get-DhcpServerv4Scope')).toContain('192.168.3.0');
    });

  it('sans `-ScopeId`, l\'option est posee au niveau SERVEUR', async () => {
    const { ps } = await serveur();
    await ps(ETENDUE);

    expect(await ps('Set-DhcpServerv4OptionValue -DnsServer 8.8.8.8')).toBe('');

    expect(await ps('Get-DhcpServerv4OptionValue')).toContain('8.8.8.8');
    expect(await ps('Get-DhcpServerv4OptionValue -ScopeId 192.168.2.0'))
      .toContain('8.8.8.8');
  });

  it('une etendue inexistante est nommee par CHAQUE commande qui la cherche',
    async () => {
      const { ps } = await serveur();
      await ps(ETENDUE);

      for (const commande of [
        'Get-DhcpServerv4OptionValue -ScopeId 192.168.9.0',
        'Set-DhcpServerv4Scope -ScopeId 192.168.9.0 -State Inactive',
        'Remove-DhcpServerv4Scope -ScopeId 192.168.9.0',
      ]) {
        const vu = await ps(commande);
        expect(vu).toMatch(/192\.168\.9\.0/);
        expect(vu).toMatch(/does not exist/i);
      }
    });

  it('`Get-DhcpServerv4Lease` d\'une etendue sans bail ne rend rien', async () => {
    const { ps } = await serveur();
    await ps(ETENDUE);

    expect((await ps('Get-DhcpServerv4Lease -ScopeId 192.168.2.0')).trim()).toBe('');
  });
});

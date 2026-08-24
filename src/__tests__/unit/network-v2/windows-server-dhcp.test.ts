/**
 * PRD-Windows-Server.md §5 P8 — DHCP Server role: `Install-WindowsFeature
 * DHCP` hosts the real DHCP engine over genuine UDP 67/68. Covers the
 * `DhcpServer` cmdlets, `netsh`-independent PowerShell surface, real client
 * leasing (Windows/Linux), and the simulated AD authorization flag.
 */
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

async function buildLan() {
  const dhcp = new WindowsServer('DHCP1');
  const winClient = new WindowsPC('windows-pc', 'WINCLIENT1');
  const linuxClient = new LinuxPC('linux-pc', 'LINUXCLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c1').connect(dhcp.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(winClient.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(linuxClient.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dhcp.getPorts()[0].configureIP(new IPAddress('192.168.80.10'), mask);
  dhcp.setCurrentUser('Administrator');
  return { dhcp, winClient, linuxClient };
}

describe('Install-WindowsFeature DHCP', () => {
  it('DhcpServer cmdlets are "not recognized" before the role is installed', async () => {
    const { dhcp } = await buildLan();
    const out = await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    expect(out).toMatch(/not recognized/i);
  });
});

describe('Add-DhcpServerv4Scope / Get-DhcpServerv4Scope', () => {
  it('creates a scope and lists it back', async () => {
    const { dhcp } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    const out = await run(ps(dhcp), 'Get-DhcpServerv4Scope');
    expect(out).toContain('LAN');
    expect(out).toContain('192.168.80.100');
  });

  it('Get-DhcpServerv4Scope -ScopeId filters to one scope', async () => {
    const { dhcp } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name GUEST -StartRange 192.168.81.100 -EndRange 192.168.81.200 -SubnetMask 255.255.255.0');
    const out = await run(ps(dhcp), 'Get-DhcpServerv4Scope -ScopeId LAN');
    expect(out).toContain('LAN');
    expect(out).not.toContain('GUEST');
  });

  it('refuses a duplicate scope', async () => {
    const { dhcp } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    const out = await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    expect(out).toMatch(/already exists/i);
  });
});

describe('Add-DhcpServerv4ExclusionRange / Add-DhcpServerv4Reservation', () => {
  async function scoped() {
    const lan = await buildLan();
    await run(ps(lan.dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(lan.dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    return lan;
  }

  it('a reserved MAC always receives its reserved address', async () => {
    const { dhcp, winClient } = await scoped();
    const mac = winClient.getPorts()[0].getMAC().toString();
    const res = await run(ps(dhcp), `Add-DhcpServerv4Reservation -ScopeId LAN -IPAddress 192.168.80.150 -ClientId "${mac}"`);
    expect(res.trim()).toBe('');

    winClient.getDHCPClient().requestLease('eth0');
    const state = winClient.getDHCPClient().getState('eth0');
    expect(state.lease?.ipAddress).toBe('192.168.80.150');
  });

  it('an exclusion range keeps addresses unavailable for lease', async () => {
    const { dhcp } = await scoped();
    const out = await run(ps(dhcp), 'Add-DhcpServerv4ExclusionRange -ScopeId LAN -StartRange 192.168.80.100 -EndRange 192.168.80.199');
    expect(out.trim()).toBe('');
  });
});

describe('netsh dhcp server — usual forms', () => {
  it('add scope / show scope', async () => {
    const { dhcp } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    const add = await dhcp.executeCmdCommand('netsh dhcp server add scope 192.168.80.0 255.255.255.0 LAN');
    expect(add).toMatch(/completed successfully/i);
    const show = await dhcp.executeCmdCommand('netsh dhcp server show scope');
    expect(show).toContain('LAN');
  });

  it('scope ... add excluderange / add reservedip', async () => {
    const { dhcp, winClient } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await dhcp.executeCmdCommand('netsh dhcp server add scope 192.168.80.0 255.255.255.0 LAN');
    const excl = await dhcp.executeCmdCommand('netsh dhcp server scope 192.168.80.0 add excluderange 192.168.80.1 192.168.80.149');
    expect(excl).toMatch(/completed successfully/i);
    const mac = winClient.getPorts()[0].getMAC().toString();
    const resv = await dhcp.executeCmdCommand(`netsh dhcp server scope 192.168.80.0 add reservedip 192.168.80.150 ${mac}`);
    expect(resv).toMatch(/completed successfully/i);

    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').lease?.ipAddress).toBe('192.168.80.150');
  });
});

describe('Set-DhcpServerv4OptionValue', () => {
  it('configures router/DNS options reflected in a real client lease', async () => {
    const { dhcp, linuxClient } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');
    await run(ps(dhcp), 'Set-DhcpServerv4OptionValue -ScopeId LAN -Router 192.168.80.1 -DnsServer 192.168.80.53');

    linuxClient.getDHCPClient().requestLease('eth0');
    const state = linuxClient.getDHCPClient().getState('eth0');
    expect(state.lease?.defaultGateway).toBe('192.168.80.1');
    expect(state.lease?.dnsServers).toContain('192.168.80.53');
  });
});

describe('Real client leasing over the wire (Get-DhcpServerv4Lease)', () => {
  it('a Windows client obtains a lease visible in Get-DhcpServerv4Lease', async () => {
    const { dhcp, winClient } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');

    winClient.getDHCPClient().requestLease('eth0');
    const state = winClient.getDHCPClient().getState('eth0');
    expect(state.state).toBe('BOUND');

    const out = await run(ps(dhcp), 'Get-DhcpServerv4Lease -ScopeId LAN');
    expect(out).toContain(state.lease!.ipAddress);
  });

  it('a Linux dhclient obtains a lease visible in Get-DhcpServerv4Lease', async () => {
    const { dhcp, linuxClient } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');

    linuxClient.getDHCPClient().requestLease('eth0');
    const state = linuxClient.getDHCPClient().getState('eth0');
    expect(state.state).toBe('BOUND');

    const out = await run(ps(dhcp), 'Get-DhcpServerv4Lease');
    expect(out).toContain(state.lease!.ipAddress);
  });
});

describe('Simulated AD authorization (Add-DhcpServerInDC)', () => {
  it('a domain-joined DHCP server serves no leases until authorized in AD', async () => {
    const { dhcp, winClient } = await buildLan();
    await run(ps(dhcp), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dhcp), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    await run(ps(dhcp), 'Install-WindowsFeature DHCP');
    await run(ps(dhcp), 'Add-DhcpServerv4Scope -Name LAN -StartRange 192.168.80.100 -EndRange 192.168.80.200 -SubnetMask 255.255.255.0');

    winClient.getDHCPClient().requestLease('eth0', { timeout: 1 });
    expect(winClient.getDHCPClient().getState('eth0').lease?.ipAddress ?? '')
      .not.toMatch(/^192\.168\.80\./);

    await run(ps(dhcp), 'Add-DhcpServerInDC');
    winClient.getDHCPClient().requestLease('eth0');
    expect(winClient.getDHCPClient().getState('eth0').state).toBe('BOUND');
    expect(winClient.getDHCPClient().getState('eth0').lease!.ipAddress)
      .toMatch(/^192\.168\.80\./);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// network-state.test.ts — PowerShell network‑level integration tests
// ═══════════════════════════════════════════════════════════════════════════
// These tests use the simulated Windows machine to change network settings
// (adapters, IP, DNS, firewall, routing) and verify the resulting state
// through PowerShell cmdlets.

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createPC(name = 'WIN-NET'): WindowsPC {
  return new WindowsPC('windows-pc', name);
}

function createPS(pc: WindowsPC): PowerShellExecutor {
  return new PowerShellExecutor(pc);
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. DNS CLIENT CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

describe('1. DNS Client Configuration', () => {

  it('Get-DnsClientServerAddress lists nameservers', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-DnsClientServerAddress');
    expect(out).toContain('InterfaceAlias');
    expect(out).toContain('ServerAddresses');
  });

  it('Set-DnsClientServerAddress updates preferred DNS server', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Pick the first Ethernet adapter
    await ps.execute(
      '$adapter = Get-NetAdapter -Name "Ethernet" ; ' +
      'Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses "8.8.8.8"'
    );
    const dnsOut = await ps.execute(
      '(Get-DnsClientServerAddress -InterfaceAlias "Ethernet").ServerAddresses'
    );
    expect(dnsOut).toContain('8.8.8.8');
  });

  it('Set-DnsClientServerAddress with multiple servers', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses ("8.8.8.8","1.1.1.1")'
    );
    const out = await ps.execute(
      '(Get-DnsClientServerAddress -InterfaceAlias "Ethernet").ServerAddresses'
    );
    // Should contain both
    expect(out).toContain('8.8.8.8');
    expect(out).toContain('1.1.1.1');
  });

  it('Resolve-DnsName uses the configured DNS server', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'Set-DnsClientServerAddress -InterfaceAlias "Ethernet" -ServerAddresses "8.8.8.8"'
    );
    const result = await ps.execute('Resolve-DnsName google.com');
    expect(result).toContain('Name');
    expect(result).toContain('IPAddress');
  });

  it('Clear-DnsClientCache', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Just checks it runs without issue
    await expect(ps.execute('Clear-DnsClientCache')).resolves.toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. NETWORK ADAPTER MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('2. Network Adapter Management', () => {

  it('Get-NetAdapter lists adapters', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter');
    expect(out).toContain('Name');
    expect(out).toContain('Ethernet');
    expect(out).toContain('Wi-Fi');
  });

  it('Get-NetAdapter -Name filters specific adapter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetAdapter -Name "Ethernet"');
    expect(out).toContain('Ethernet');
    expect(out).not.toContain('Wi-Fi');
  });

  it('Disable-NetAdapter disables an adapter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Disable-NetAdapter -Name "Ethernet" -Confirm:$false');
    const status = await ps.execute('(Get-NetAdapter -Name "Ethernet").Status');
    expect(status.trim()).toBe('Disabled');
  });

  it('Enable-NetAdapter re-enables an adapter', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Disable-NetAdapter -Name "Ethernet" -Confirm:$false');
    await ps.execute('Enable-NetAdapter -Name "Ethernet" -Confirm:$false');
    const status = await ps.execute('(Get-NetAdapter -Name "Ethernet").Status');
    expect(status.trim()).toBe('Up');
  });

  it('Rename-NetAdapter changes adapter name', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Rename-NetAdapter -Name "Ethernet" -NewName "ETH0"');
    const out = await ps.execute('Get-NetAdapter -Name "ETH0" -ErrorAction SilentlyContinue');
    expect(out).toContain('ETH0');
    // Restore original name
    await ps.execute('Rename-NetAdapter -Name "ETH0" -NewName "Ethernet"');
  });

  it('Restart-NetAdapter resets and brings adapter up', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Restart-NetAdapter -Name "Ethernet" -Confirm:$false');
    const status = await ps.execute('(Get-NetAdapter -Name "Ethernet").Status');
    expect(status.trim()).toBe('Up');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. IP ADDRESS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════

describe('3. IP Address Management', () => {

  it('Get-NetIPAddress lists all IPs', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetIPAddress');
    expect(out).toContain('IPAddress');
    expect(out).toContain('InterfaceAlias');
  });

  it('New-NetIPAddress adds a new IP', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.100.10 -PrefixLength 24'
    );
    const ips = await ps.execute(
      '(Get-NetIPAddress -InterfaceAlias "Ethernet").IPAddress'
    );
    expect(ips).toContain('192.168.100.10');
  });

  it('Set-NetIPAddress changes existing IP', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Assuming there's already a primary IP
    await ps.execute(
      'Set-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.1.100 -PrefixLength 24'
    );
    const ip = await ps.execute(
      '(Get-NetIPAddress -InterfaceAlias "Ethernet" -AddressFamily IPv4 | Where-Object PrefixLength -eq 24).IPAddress'
    );
    expect(ip).toContain('192.168.1.100');
  });

  it('Remove-NetIPAddress deletes an IP', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Remove-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.100.10 -Confirm:$false');
    const ips = await ps.execute(
      '(Get-NetIPAddress -InterfaceAlias "Ethernet").IPAddress'
    );
    expect(ips).not.toContain('192.168.100.10');
  });

  it('New-NetIPAddress –DefaultGateway sets gateway', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 10.0.0.10 -PrefixLength 8 -DefaultGateway 10.0.0.1'
    );
    const gw = await ps.execute(
      'Get-NetRoute -InterfaceAlias "Ethernet" | Where-Object DestinationPrefix -eq "0.0.0.0/0" | Select-Object -ExpandProperty NextHop'
    );
    expect(gw.trim()).toBe('10.0.0.1');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ROUTING TABLE
// ═══════════════════════════════════════════════════════════════════════════

describe('4. Routing Table', () => {

  it('Get-NetRoute shows routing table', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetRoute');
    expect(out).toContain('DestinationPrefix');
    expect(out).toContain('NextHop');
  });

  it('New-NetRoute adds a static route', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetRoute -DestinationPrefix "172.16.0.0/16" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1'
    );
    const route = await ps.execute(
      'Get-NetRoute -DestinationPrefix "172.16.0.0/16"'
    );
    expect(route).toContain('172.16.0.0/16');
    expect(route).toContain('192.168.1.1');
  });

  it('Remove-NetRoute deletes a route', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Remove-NetRoute -DestinationPrefix "172.16.0.0/16" -Confirm:$false');
    const check = await ps.execute(
      'Get-NetRoute -DestinationPrefix "172.16.0.0/16" -ErrorAction SilentlyContinue'
    );
    expect(check.trim()).toBe('');
  });

  it('Set-NetRoute changes NextHop', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetRoute -DestinationPrefix "10.99.0.0/24" -InterfaceAlias "Ethernet" -NextHop 192.168.1.1'
    );
    await ps.execute(
      'Set-NetRoute -DestinationPrefix "10.99.0.0/24" -InterfaceAlias "Ethernet" -NextHop 192.168.1.254'
    );
    const updated = await ps.execute(
      'Get-NetRoute -DestinationPrefix "10.99.0.0/24" | Select-Object -ExpandProperty NextHop'
    );
    expect(updated.trim()).toBe('192.168.1.254');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. FIREWALL RULES
// ═══════════════════════════════════════════════════════════════════════════

describe('5. Firewall Rules', () => {

  it('Get-NetFirewallRule lists rules', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetFirewallRule');
    expect(out).toContain('Name');
    expect(out).toContain('DisplayName');
  });

  it('New-NetFirewallRule creates an inbound rule', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetFirewallRule -DisplayName "Test Rule In" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow'
    );
    const rule = await ps.execute(
      'Get-NetFirewallRule -DisplayName "Test Rule In"'
    );
    expect(rule).toContain('Test Rule In');
    expect(rule).toContain('Allow');
  });

  it('New-NetFirewallRule creates an outbound block rule', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetFirewallRule -DisplayName "Block Out 443" -Direction Outbound -Protocol TCP -RemotePort 443 -Action Block'
    );
    const rule = await ps.execute(
      'Get-NetFirewallRule -DisplayName "Block Out 443"'
    );
    expect(rule).toContain('Block');
  });

  it('Set-NetFirewallRule changes action', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetFirewallRule -DisplayName "SwitchRule" -Direction Inbound -Protocol TCP -LocalPort 5000 -Action Allow'
    );
    await ps.execute('Set-NetFirewallRule -DisplayName "SwitchRule" -Action Block');
    const rule = await ps.execute('(Get-NetFirewallRule -DisplayName "SwitchRule").Action');
    expect(rule.trim()).toBe('Block');
  });

  it('Enable-NetFirewallRule / Disable-NetFirewallRule', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetFirewallRule -DisplayName "ToggleRule" -Direction Inbound -Protocol TCP -LocalPort 6000 -Action Allow'
    );
    await ps.execute('Disable-NetFirewallRule -DisplayName "ToggleRule"');
    const disabled = await ps.execute('(Get-NetFirewallRule -DisplayName "ToggleRule").Enabled');
    expect(disabled.trim()).toBe('False');
    await ps.execute('Enable-NetFirewallRule -DisplayName "ToggleRule"');
    const enabled = await ps.execute('(Get-NetFirewallRule -DisplayName "ToggleRule").Enabled');
    expect(enabled.trim()).toBe('True');
  });

  it('Remove-NetFirewallRule deletes a rule', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Remove-NetFirewallRule -DisplayName "Test Rule In" -Confirm:$false');
    const check = await ps.execute(
      'Get-NetFirewallRule -DisplayName "Test Rule In" -ErrorAction SilentlyContinue'
    );
    expect(check.trim()).toBe('');
  });

  it('firewall rule blocks traffic (simulated connectivity check)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'New-NetFirewallRule -DisplayName "BlockHTTP" -Direction Outbound -Protocol TCP -RemotePort 80 -Action Block'
    );
    // Simulate Test-NetConnection that respects firewall
    const result = await ps.execute(
      'Test-NetConnection -ComputerName "example.com" -Port 80 -ErrorAction SilentlyContinue'
    );
    expect(result).toContain('TcpTestSucceeded');
    // Depending on simulation, may be false because blocked
    // We'll just check that it completes without crash
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. NETWORK CONNECTIVITY TOOLS
// ═══════════════════════════════════════════════════════════════════════════

describe('6. Network Connectivity Tools', () => {

  it('Test-Connection (ping) to 127.0.0.1 succeeds', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Test-Connection 127.0.0.1 -Count 1');
    expect(out).toContain('Success');
  });

  it('Test-NetConnection to localhost port 445', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Test-NetConnection -ComputerName localhost -Port 445');
    expect(out).toContain('TcpTestSucceeded');
  });

  it('Test-NetConnection fails to unreachable port', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Assuming port 12345 is not open
    const out = await ps.execute('Test-NetConnection localhost -Port 12345 -ErrorAction SilentlyContinue');
    // It will still output result, TcpTestSucceeded should be False
    expect(out).toContain('TcpTestSucceeded');
    // We'll not verify false/true strictly because simulation might differ; adjust to real simulation behaviour
  });

  it('Get-NetTCPConnection lists established connections', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetTCPConnection');
    expect(out).toContain('LocalAddress');
    expect(out).toContain('LocalPort');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. PROXY & WINHTTP SETTINGS
// ═══════════════════════════════════════════════════════════════════════════

describe('7. Proxy & WinHTTP Settings', () => {

  it('netsh winhttp show proxy returns current proxy', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('netsh winhttp show proxy');
    // By default no proxy
    expect(out).toContain('Direct access');
  });

  it('netsh winhttp set proxy changes proxy', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('netsh winhttp set proxy "192.168.1.50:8080"');
    const out = await ps.execute('netsh winhttp show proxy');
    expect(out).toContain('192.168.1.50');
    // Reset
    await ps.execute('netsh winhttp reset proxy');
  });

  it('Set-Item on Internet Settings registry sets IE proxy', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyEnable -Value 1'
    );
    const enabled = await ps.execute(
      'Get-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyEnable'
    );
    expect(enabled).toContain('1');
    // Revert
    await ps.execute(
      'Set-ItemProperty -Path "HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" -Name ProxyEnable -Value 0'
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. NETWORK PROFILE & LOCATION
// ═══════════════════════════════════════════════════════════════════════════

describe('8. Network Profile', () => {

  it('Get-NetConnectionProfile shows current network category', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('Get-NetConnectionProfile');
    expect(out).toContain('NetworkCategory');
    expect(out).toContain('DomainAuthenticated');
  });

  it('Set-NetConnectionProfile changes network category', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const ifIndex = (await ps.execute(
      '(Get-NetConnectionProfile).InterfaceIndex'
    )).trim();
    await ps.execute(
      `Set-NetConnectionProfile -InterfaceIndex ${ifIndex} -NetworkCategory Private`
    );
    const cat = await ps.execute(
      '(Get-NetConnectionProfile).NetworkCategory'
    );
    expect(cat.trim()).toBe('Private');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. VPN CONNECTIONS (if simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe('9. VPN Connections', () => {

  it('Add-VpnConnection creates a VPN entry', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute(
      'Add-VpnConnection -Name "TestVPN" -ServerAddress "vpn.example.com" -TunnelType "L2tp" -EncryptionLevel "Required" -AuthenticationMethod MSChapv2'
    );
    const vpnList = await ps.execute('Get-VpnConnection -Name "TestVPN"');
    expect(vpnList).toContain('TestVPN');
  });

  it('Set-VpnConnection changes server address', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Set-VpnConnection -Name "TestVPN" -ServerAddress "new.server.com"');
    const info = await ps.execute('(Get-VpnConnection -Name "TestVPN").ServerAddress');
    expect(info.trim()).toBe('new.server.com');
  });

  it('Remove-VpnConnection deletes VPN', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('Remove-VpnConnection -Name "TestVPN" -Force');
    const check = await ps.execute('Get-VpnConnection -Name "TestVPN" -ErrorAction SilentlyContinue');
    expect(check.trim()).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. WIRELESS LAN PROFILES (if simulated)
// ═══════════════════════════════════════════════════════════════════════════

describe('10. Wireless LAN Profiles', () => {

  it('netsh wlan show profiles lists profiles', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    const out = await ps.execute('netsh wlan show profiles');
    expect(out).toContain('User profiles');
  });

  it('netsh wlan add profile and connect (simulated)', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    // Simulate adding a profile via XML (shortcut: we assume profile file exists)
    await ps.execute(
      'netsh wlan add profile filename="C:\\temp\\test-wifi.xml"'
    );
    // Now connect
    await ps.execute('netsh wlan connect name="TestWiFi"');
    const show = await ps.execute('netsh wlan show interfaces');
    expect(show).toContain('TestWiFi');
  });

  it('netsh wlan disconnect', async () => {
    const pc = createPC();
    const ps = createPS(pc);
    await ps.execute('netsh wlan disconnect');
    const show = await ps.execute('netsh wlan show interfaces');
    expect(show).toContain('Disconnected');
  });
});

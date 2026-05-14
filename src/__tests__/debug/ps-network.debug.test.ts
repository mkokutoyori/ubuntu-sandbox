/**
 * Debug run — networking cmdlets on a Windows PC + Windows Server.
 *
 * Drives `Get-NetIPAddress`, `Get-NetAdapter`, `Test-Connection`,
 * `Resolve-DnsName`, ipconfig/ping/tracert/netstat/arp aliases.
 * Transcript → `debug-output/ps-network_results_debug.txt`.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellExecutor } from '@/network/devices/windows/PowerShellExecutor';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { runAndDump, type DebugCommandInput } from './_dump';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

describe('debug — PowerShell networking', () => {
  it('runs network cmdlets and writes the transcript', async () => {
    const pc = new WindowsPC('windows-pc', 'WIN-NET-DBG');
    const srv = new WindowsPC('windows-server', 'SRV-NET-DBG');
    pc.setCurrentUser('Administrator');
    srv.setCurrentUser('Administrator');
    const psPc = new PowerShellExecutor(pc);
    const psSrv = new PowerShellExecutor(srv);

    const commands: DebugCommandInput[] = [
      // ── 1. adapters / IP configuration ────────────────────────────
      { section: 'adapters & IP', cmd: 'Get-NetAdapter' },
      'Get-NetAdapter | Format-Table Name, Status, MacAddress, LinkSpeed -AutoSize',
      'Get-NetAdapter | Sort-Object Name',
      'Get-NetAdapter | Where-Object { $_.Status -eq "Up" }',
      'Get-NetAdapter | Where-Object { $_.Status -ne "Up" }',
      '(Get-NetAdapter).Count',
      'Get-NetAdapter | Select-Object -First 1 | Format-List *',
      'Get-NetIPAddress',
      'Get-NetIPAddress | Format-Table InterfaceAlias, IPAddress, AddressFamily, PrefixLength -AutoSize',
      'Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue',
      'Get-NetIPAddress -AddressFamily IPv6 -ErrorAction SilentlyContinue',
      'Get-NetIPAddress | Where-Object { $_.AddressFamily -eq "IPv4" }',
      'Get-NetIPAddress | Where-Object { $_.IPAddress -like "192.*" }',
      'Get-NetIPAddress | Sort-Object IPAddress',
      'Get-NetIPConfiguration -ErrorAction SilentlyContinue',
      'Get-NetRoute -ErrorAction SilentlyContinue',
      'Get-NetRoute | Sort-Object DestinationPrefix -ErrorAction SilentlyContinue',
      'Get-DnsClientServerAddress -ErrorAction SilentlyContinue',

      // ── 2. legacy aliases (ipconfig / netstat / route / arp) ──────
      { section: 'legacy aliases', cmd: 'ipconfig' },
      'ipconfig /all',
      'ipconfig /displaydns',
      'netstat',
      'netstat -a',
      'netstat -n',
      'netstat -ano',
      'arp -a',
      'route print',
      'route print -4',
      'hostname',
      'getmac',

      // ── 3. connectivity tests ─────────────────────────────────────
      { section: 'connectivity', cmd: 'Test-Connection localhost -Count 1 -ErrorAction SilentlyContinue' },
      'Test-Connection 127.0.0.1 -Count 1 -ErrorAction SilentlyContinue',
      'Test-Connection localhost -Count 2 -ErrorAction SilentlyContinue',
      'Test-Connection 8.8.8.8 -Count 1 -ErrorAction SilentlyContinue',
      'Test-Connection nonexistent.invalid -Count 1 -ErrorAction SilentlyContinue',
      'Test-NetConnection localhost -ErrorAction SilentlyContinue',
      'Test-NetConnection 127.0.0.1 -Port 80 -ErrorAction SilentlyContinue',
      'ping localhost',
      'ping 127.0.0.1',
      'ping -n 1 127.0.0.1',
      'ping -n 4 127.0.0.1',
      'tracert localhost',
      'tracert 127.0.0.1',

      // ── 4. DNS resolution ─────────────────────────────────────────
      { section: 'DNS', cmd: 'Resolve-DnsName localhost -ErrorAction SilentlyContinue' },
      'Resolve-DnsName 127.0.0.1 -ErrorAction SilentlyContinue',
      'Resolve-DnsName example.com -ErrorAction SilentlyContinue',
      'Resolve-DnsName example.com -Type A -ErrorAction SilentlyContinue',
      'Resolve-DnsName example.com -Type AAAA -ErrorAction SilentlyContinue',
      'Resolve-DnsName example.com -Type MX -ErrorAction SilentlyContinue',
      'nslookup localhost',
      'nslookup 127.0.0.1',
      'Clear-DnsClientCache -ErrorAction SilentlyContinue',
      'Get-DnsClientCache -ErrorAction SilentlyContinue',

      // ── 5. complex pipelines ──────────────────────────────────────
      { section: 'complex pipelines',
        cmd: 'Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | ForEach-Object { Get-NetIPAddress -InterfaceAlias $_.Name -ErrorAction SilentlyContinue }' },
      'Get-NetIPAddress | Group-Object AddressFamily | Format-Table Name, Count -AutoSize',
      'Get-NetAdapter | Sort-Object Name | Select-Object Name, Status, MacAddress | Format-Table -AutoSize',
      'Get-NetIPAddress | Where-Object { $_.AddressFamily -eq "IPv4" } | Select-Object IPAddress, InterfaceAlias, PrefixLength | Format-Table -AutoSize',
      '"127.0.0.1","localhost" | ForEach-Object { Test-Connection $_ -Count 1 -ErrorAction SilentlyContinue }',
      'Get-NetAdapter | ForEach-Object { "$($_.Name) -> $($_.Status)" }',
      'Get-NetAdapter | Where-Object { $_.Name -match "Ethernet" } | Format-List Name, Status, MacAddress',
      'Get-NetRoute -ErrorAction SilentlyContinue | Sort-Object RouteMetric | Select-Object -First 5',

      // ── 6. firewall (if surfaced) ─────────────────────────────────
      { section: 'firewall (best-effort)', cmd: 'Get-NetFirewallRule -ErrorAction SilentlyContinue | Select-Object -First 3' },
      'Get-NetFirewallProfile -ErrorAction SilentlyContinue',
      'New-NetFirewallRule -DisplayName "DebugRule" -Direction Inbound -Action Allow -LocalPort 8080 -Protocol TCP -ErrorAction SilentlyContinue',
      'Get-NetFirewallRule -DisplayName "DebugRule" -ErrorAction SilentlyContinue',
      'Remove-NetFirewallRule -DisplayName "DebugRule" -ErrorAction SilentlyContinue',

      // ── 7. shares (best-effort) ───────────────────────────────────
      { section: 'shares (best-effort)', cmd: 'Get-SmbShare -ErrorAction SilentlyContinue' },
      'Get-SmbConnection -ErrorAction SilentlyContinue',
      'New-SmbShare -Name "DebugShare" -Path "C:\\" -ReadAccess Everyone -ErrorAction SilentlyContinue',
      'Get-SmbShare -Name "DebugShare" -ErrorAction SilentlyContinue',
      'Remove-SmbShare -Name "DebugShare" -Force -ErrorAction SilentlyContinue',

      // ── 8. summary ────────────────────────────────────────────────
      { section: 'summary', cmd: 'Get-NetAdapter | Group-Object Status | Format-Table Name, Count -AutoSize' },
      'Get-NetIPAddress | Group-Object AddressFamily | Format-Table Name, Count -AutoSize',
      '(Get-NetAdapter).Count',
      '$env:COMPUTERNAME',
    ];

    await runAndDump('ps-network', commands, psPc,
      'host=WIN-NET-DBG (windows-pc)');

    // Secondary pass on the server.
    const srvCommands: DebugCommandInput[] = [
      { section: 'server', cmd: '$env:COMPUTERNAME' },
      'Get-NetAdapter',
      'Get-NetIPAddress',
      'Test-Connection 127.0.0.1 -Count 1 -ErrorAction SilentlyContinue',
      'Test-Connection 127.0.0.1 -Count 2 -ErrorAction SilentlyContinue',
      'Test-Connection localhost -Count 1 -ErrorAction SilentlyContinue',
      'Resolve-DnsName localhost -ErrorAction SilentlyContinue',
      'Resolve-DnsName 127.0.0.1 -ErrorAction SilentlyContinue',
      'Resolve-DnsName example.com -ErrorAction SilentlyContinue',
      'ipconfig',
      'ipconfig /all',
      'ipconfig /displaydns',
      'netstat',
      'netstat -a',
      'netstat -ano',
      'arp -a',
      'route print',
      'route print -4',
      'hostname',
      'getmac',
      'Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | Select-Object Name, MacAddress',
      'Get-NetIPAddress | Where-Object { $_.AddressFamily -eq "IPv4" } | Select-Object InterfaceAlias, IPAddress',
      'Get-NetAdapter | Sort-Object Name | Select-Object Name, Status',
      'Get-NetIPAddress | Group-Object AddressFamily | Format-Table Name, Count -AutoSize',
      'Get-NetRoute -ErrorAction SilentlyContinue | Select-Object -First 5',
      'Get-DnsClientServerAddress -ErrorAction SilentlyContinue',
      '(Get-NetAdapter).Count',
      '(Get-NetIPAddress).Count',
    ];
    await runAndDump('ps-network-server', srvCommands, psSrv,
      'host=SRV-NET-DBG (windows-server)');

    expect(commands.length + srvCommands.length).toBeGreaterThanOrEqual(100);
  }, 120_000);
});

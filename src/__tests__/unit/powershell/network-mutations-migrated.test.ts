/**
 * Migrated network-mutation cmdlets (Phase 3).
 *
 * Each test goes through PowerShellSubShell so it exercises the same
 * dispatch path users see (interpreter first, executor fallback).
 * Adapter / IP / route / firewall / connection-profile state is now
 * shared between the two engines via WindowsPSProviders.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

function createShell() {
  const pc = new WindowsPC('windows-pc', 'WIN-NETMUT');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('IP address mutations', () => {
  // Bare IPs (10.10.10.10) get tokenised as truncated numbers by the lexer,
  // so quote them.
  it('New-NetIPAddress + Get-NetIPAddress shows the new IP', async () => {
    const sh = createShell();
    await run(sh, 'New-NetIPAddress -IPAddress "10.10.10.10" -InterfaceAlias eth0 -PrefixLength 24');
    const out = await run(sh, 'Get-NetIPAddress -InterfaceAlias eth0');
    expect(out).toContain('10.10.10.10');
  });

  it('Remove-NetIPAddress drops the IP', async () => {
    const sh = createShell();
    await run(sh, 'New-NetIPAddress -IPAddress "10.10.10.11" -InterfaceAlias eth0 -PrefixLength 24');
    await run(sh, 'Remove-NetIPAddress -IPAddress "10.10.10.11"');
    const out = await run(sh, 'Get-NetIPAddress -InterfaceAlias eth0');
    expect(out).not.toContain('10.10.10.11');
  });
});

describe('Route mutations', () => {
  it('New-NetRoute then Get-NetRoute shows the route', async () => {
    const sh = createShell();
    await run(sh, 'New-NetRoute -DestinationPrefix "192.168.99.0/24" -InterfaceAlias eth0 -NextHop "10.0.0.1" -RouteMetric 5');
    const out = await run(sh, 'Get-NetRoute');
    expect(out).toContain('192.168.99.0/24');
  });

  it('Remove-NetRoute drops the route', async () => {
    const sh = createShell();
    await run(sh, 'New-NetRoute -DestinationPrefix "192.168.50.0/24" -InterfaceAlias eth0 -NextHop "10.0.0.1"');
    await run(sh, 'Remove-NetRoute -DestinationPrefix "192.168.50.0/24"');
    const out = await run(sh, 'Get-NetRoute');
    expect(out).not.toContain('192.168.50.0/24');
  });
});

describe('Adapter actions', () => {
  it('Disable-NetAdapter then Get-NetAdapter shows Disabled', async () => {
    const sh = createShell();
    await run(sh, 'Disable-NetAdapter -Name eth0');
    const out = await run(sh, 'Get-NetAdapter');
    expect(out).toMatch(/disabled/i);
  });

  it('Rename-NetAdapter changes the displayed name', async () => {
    const sh = createShell();
    await run(sh, 'Rename-NetAdapter -Name eth0 -NewName Lan1');
    const out = await run(sh, 'Get-NetAdapter');
    expect(out).toContain('Lan1');
  });
});

describe('DNS client', () => {
  it('Set-DnsClientServerAddress + Get-DnsClientServerAddress', async () => {
    const sh = createShell();
    // Quoted IPs — bare 8.8.8.8 is parsed as a number sequence by the lexer.
    await run(sh, 'Set-DnsClientServerAddress -InterfaceAlias eth0 -ServerAddresses "8.8.8.8","1.1.1.1"');
    const out = await run(sh, 'Get-DnsClientServerAddress -InterfaceAlias eth0');
    expect(out).toContain('8.8.8.8');
    expect(out).toContain('1.1.1.1');
  });

  it('Clear-DnsClientCache is a silent no-op', async () => {
    const sh = createShell();
    const out = await run(sh, 'Clear-DnsClientCache');
    expect(out).toBe('');
  });
});

describe('Firewall rules', () => {
  it('New-NetFirewallRule + Get-NetFirewallRule lists the rule', async () => {
    const sh = createShell();
    await run(sh, 'New-NetFirewallRule -DisplayName "Allow8080" -Direction Inbound -Action Allow -LocalPort 8080 -Protocol TCP');
    const out = await run(sh, 'Get-NetFirewallRule');
    expect(out).toContain('Allow8080');
  });

  it('Disable-NetFirewallRule flips Enabled to False', async () => {
    const sh = createShell();
    await run(sh, 'New-NetFirewallRule -DisplayName "ToDisable" -Direction Inbound -Action Allow -Enabled $true');
    await run(sh, 'Disable-NetFirewallRule -DisplayName ToDisable');
    const out = await run(sh, 'Get-NetFirewallRule');
    expect(out).toMatch(/todisable[\s\S]*false/i);
  });

  it('Remove-NetFirewallRule deletes the rule', async () => {
    const sh = createShell();
    await run(sh, 'New-NetFirewallRule -DisplayName "ToRemove" -Direction Inbound -Action Block');
    await run(sh, 'Remove-NetFirewallRule -DisplayName ToRemove');
    const out = await run(sh, 'Get-NetFirewallRule');
    expect(out).not.toContain('ToRemove');
  });
});

describe('Connection profile', () => {
  it('Set-NetConnectionProfile + Get-NetConnectionProfile returns the new category', async () => {
    const sh = createShell();
    await run(sh, 'Set-NetConnectionProfile -InterfaceAlias eth0 -NetworkCategory Public');
    const out = await run(sh, 'Get-NetConnectionProfile');
    expect(out).toContain('Public');
  });
});

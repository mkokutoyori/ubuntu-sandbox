/**
 * Phase 3 final batches — EventLog -List, ScheduledTask, Disk/Volume,
 * Set-NetIPAddress, Set-NetRoute, Restart-NetAdapter, Test-NetConnection,
 * Get-CimInstance shim. End-to-end through PowerShellSubShell.
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
  const pc = new WindowsPC('windows-pc', 'WIN-FINAL');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('EventLog -List structured output', () => {
  it('Get-EventLog -List enumerates known logs', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-EventLog -List');
    expect(out.toLowerCase()).toContain('system');
  });
});

describe('ScheduledTask cmdlets', () => {
  it('Get-ScheduledTask lists seeded tasks', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-ScheduledTask');
    expect(out).toContain('SimTestTask');
  });

  it('Register-ScheduledTask + Get-ScheduledTask shows the new task', async () => {
    const sh = createShell();
    await run(sh, 'Register-ScheduledTask -TaskName MyJob');
    const out = await run(sh, 'Get-ScheduledTask -TaskName MyJob');
    expect(out).toContain('MyJob');
  });

  it('Unregister-ScheduledTask removes it', async () => {
    const sh = createShell();
    await run(sh, 'Register-ScheduledTask -TaskName Trash');
    await run(sh, 'Unregister-ScheduledTask -TaskName Trash');
    const out = await run(sh, 'Get-ScheduledTask -TaskName Trash');
    expect(out).not.toContain('Trash');
  });
});

describe('Disk / Volume', () => {
  it('Get-Disk lists at least one disk', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Disk');
    expect(out).toContain('Virtual HD');
  });

  it('Get-Volume lists C: at minimum', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-Volume');
    expect(out).toContain('C');
  });
});

describe('Net IP / Route mutations', () => {
  it('Set-NetIPAddress updates an existing IP prefix', async () => {
    const sh = createShell();
    await run(sh, 'New-NetIPAddress -IPAddress "10.20.30.40" -InterfaceAlias eth0 -PrefixLength 24');
    await run(sh, 'Set-NetIPAddress -IPAddress "10.20.30.40" -PrefixLength 16');
    const out = await run(sh, 'Get-NetIPAddress -InterfaceAlias eth0');
    expect(out).toContain('10.20.30.40');
  });

  it('Set-NetRoute can change the next hop', async () => {
    const sh = createShell();
    await run(sh, 'New-NetRoute -DestinationPrefix "192.168.77.0/24" -InterfaceAlias eth0 -NextHop "10.0.0.1"');
    await run(sh, 'Set-NetRoute -DestinationPrefix "192.168.77.0/24" -NextHop "10.0.0.2"');
    const out = await run(sh, 'Get-NetRoute');
    expect(out).toContain('10.0.0.2');
  });

  it('Restart-NetAdapter cycles status without error', async () => {
    const sh = createShell();
    const out = await run(sh, 'Restart-NetAdapter -Name eth0');
    expect(out).not.toMatch(/error|exception/i);
  });
});

describe('Test-NetConnection', () => {
  it('returns a structured row including ComputerName', async () => {
    const sh = createShell();
    const out = await run(sh, 'Test-NetConnection -ComputerName "8.8.8.8"');
    expect(out).toContain('8.8.8.8');
  });
});

describe('Get-CimInstance shim', () => {
  it('Win32_Service returns at least one service', async () => {
    const sh = createShell();
    const out = await run(sh, 'Get-CimInstance -ClassName Win32_Service');
    expect(out.toLowerCase()).toContain('spooler');
  });
});

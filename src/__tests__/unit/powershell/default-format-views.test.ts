/**
 * Default-format views for well-known PS object shapes.
 *
 * Bug from debug-output/ps-services-processes_results_debug.txt:
 *
 *     PS> Get-Service | Sort-Object Name
 *       Status              : Running
 *       Name                : Afd
 *       DisplayName         : Ancillary Function Driver for Winsock
 *       ServiceType         : KERNEL_DRIVER
 *       ...
 *
 * Real PowerShell preserves the 3-column table view across pipeline
 * stages because `Format.ps1xml` declares it as the default view for
 * the Service type. Our simulator was falling back to Format-List once
 * the object had >4 properties. Now `formatDefault` recognises the
 * shape and re-applies the canonical columns.
 */

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

function createPS(): PowerShellExecutor {
  const pc = new WindowsPC('windows-pc', 'WIN-FMT');
  pc.setCurrentUser('Administrator');
  return new PowerShellExecutor(pc);
}

describe('default-view: Service', () => {
  it('Get-Service | Sort-Object Name keeps the 3-column table', async () => {
    const ps = createPS();
    const out = await ps.execute('Get-Service | Sort-Object Name');
    const header = out.split('\n').find((l) => l.includes('Status') && l.includes('Name') && l.includes('DisplayName'));
    expect(header).toBeDefined();
    // Should NOT emit the list-style block.
    expect(out).not.toMatch(/Status\s+:\s+Running/);
    expect(out).not.toMatch(/ServiceType\s+:/);
  });

  it('Get-Service | Where-Object {...} keeps the 3-column view', async () => {
    const ps = createPS();
    const out = await ps.execute('Get-Service | Where-Object { $_.Status -eq "Running" }');
    expect(out).not.toMatch(/ServiceType\s+:/);
  });
});

describe('default-view: NetAdapter', () => {
  it('Get-NetAdapter | Sort-Object Name keeps Name/Status/MacAddress columns', async () => {
    const ps = createPS();
    const out = await ps.execute('Get-NetAdapter | Sort-Object Name');
    expect(out).toContain('Name');
    expect(out).toContain('Status');
    expect(out).toContain('MacAddress');
  });
});

describe('default-view: LocalUser', () => {
  it('Get-LocalUser keeps Name/Enabled/Description (no overflow to list)', async () => {
    const ps = createPS();
    const out = await ps.execute('Get-LocalUser | Sort-Object Name');
    expect(out).toContain('Name');
    expect(out).toContain('Enabled');
    expect(out).toContain('Description');
  });
});

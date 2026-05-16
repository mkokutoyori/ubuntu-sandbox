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

function createShell(): PowerShellSubShell {
  const pc = new WindowsPC('windows-pc', 'WIN-FMT');
  pc.setCurrentUser('Administrator');
  return PowerShellSubShell.create(pc).subShell;
}
async function run(sh: PowerShellSubShell, line: string): Promise<string> {
  const r = await sh.processLine(line);
  return r.output.join('\n');
}

describe('default-view: Service', () => {
  it('Get-Service | Sort-Object Name keeps the 3-column table', async () => {
    
    const out = await run(createShell(), 'Get-Service | Sort-Object Name');
    const header = out.split('\n').find((l) => l.includes('Status') && l.includes('Name') && l.includes('DisplayName'));
    expect(header).toBeDefined();
    // Should NOT emit the list-style block.
    expect(out).not.toMatch(/Status\s+:\s+Running/);
    expect(out).not.toMatch(/ServiceType\s+:/);
  });

  it('Get-Service | Where-Object {...} keeps the 3-column view', async () => {
    
    const out = await run(createShell(), 'Get-Service | Where-Object { $_.Status -eq "Running" }');
    expect(out).not.toMatch(/ServiceType\s+:/);
  });
});

describe('default-view: NetAdapter', () => {
  it('Get-NetAdapter | Sort-Object Name keeps Name/Status/MacAddress columns', async () => {
    
    const out = await run(createShell(), 'Get-NetAdapter | Sort-Object Name');
    expect(out).toContain('Name');
    expect(out).toContain('Status');
    expect(out).toContain('MacAddress');
  });
});

describe('default-view: LocalUser', () => {
  it('Get-LocalUser keeps Name/Enabled/Description (no overflow to list)', async () => {
    
    const out = await run(createShell(), 'Get-LocalUser | Sort-Object Name');
    expect(out).toContain('Name');
    expect(out).toContain('Enabled');
    expect(out).toContain('Description');
  });
});

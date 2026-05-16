/**
 * Regression tests for Format-Table / Format-List multi-column parsing.
 *
 * Bug captured from debug-output/ps-users-groups-server_results_debug.txt:
 *
 *     PS> Get-LocalGroupMember -Group Deployers | Format-Table Name, ObjectClass -AutoSize
 *       Name
 *       -----------
 *       svc-deploy
 *       svc-monitor
 *
 * Only `Name` is rendered — `ObjectClass` is silently dropped. Same shape
 * for `Format-Table Name, Description`. Root cause: in
 * `PSPipeline.formatTable`, once `properties` is set on the first bare
 * positional token, subsequent positional tokens are skipped.
 *
 * Mirror bug exists for Format-List (per code inspection).
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

describe('Format-Table — multi-column positional parsing', () => {
  it('renders both columns when given `Name, Description` (positional)', async () => {
    const sh = createShell();
    await run(sh, 'New-LocalUser -Name fmtuser1 -NoPassword -Description "first"');
    await run(sh, 'New-LocalUser -Name fmtuser2 -NoPassword -Description "second"');
    const out = await run(sh,
      'Get-LocalUser | Where-Object { $_.Name -like "fmtuser*" } | Format-Table Name, Description',
    );
    expect(out).toContain('Name');
    expect(out).toContain('Description');
    expect(out).toContain('fmtuser1');
    expect(out).toContain('first');
    expect(out).toContain('second');
  });

  it('renders three columns when given `Name, Status, StartType`', async () => {
    
    const out = await run(createShell(), 
      'Get-Service | Select-Object -First 3 | Format-Table Name, Status, StartType',
    );
    expect(out).toContain('Name');
    expect(out).toContain('Status');
    expect(out).toContain('StartType');
  });

  it('handles `Name, ObjectClass -AutoSize` (positional + switch)', async () => {
    const sh = createShell();
    await run(sh, 'New-LocalUser -Name svc-deploy -NoPassword');
    await run(sh, 'New-LocalGroup -Name Deployers');
    await run(sh, 'Add-LocalGroupMember -Group Deployers -Member svc-deploy');
    const out = await run(sh,
      'Get-LocalGroupMember -Group Deployers | Format-Table Name, ObjectClass -AutoSize',
    );
    expect(out).toContain('Name');
    expect(out).toContain('ObjectClass');
    expect(out).toContain('svc-deploy');
  });

  it('Group-Object | Format-Table Name, Count -AutoSize renders both columns', async () => {
    
    const out = await run(createShell(), 
      'Get-NetIPAddress | Group-Object AddressFamily | Format-Table Name, Count -AutoSize',
    );
    expect(out).toContain('Name');
    expect(out).toContain('Count');
    // At least one address family + a numeric count should be present.
    expect(out).toMatch(/IPv4|IPv6/);
    expect(out).toMatch(/\d/);
  });

  it('explicit -Property still works (regression guard)', async () => {
    
    const out = await run(createShell(), 
      'Get-Service | Select-Object -First 2 | Format-Table -Property Name, Status',
    );
    expect(out).toContain('Name');
    expect(out).toContain('Status');
  });
});

describe('Format-List — multi-column positional parsing', () => {
  it('renders all three keys when given `Name, Id, CPU`', async () => {
    
    const out = await run(createShell(), 
      'Get-Process | Select-Object -First 1 | Format-List Name, Id, CPU',
    );
    expect(out).toContain('Name');
    expect(out).toContain('Id');
    expect(out).toContain('CPU');
  });
});

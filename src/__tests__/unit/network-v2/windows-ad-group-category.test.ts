import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function promotedDc(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  return dc;
}

describe('New-ADGroup -GroupCategory (docs/PRD-Exchange.md §2.1 P3-préalable)', () => {
  it('non-regression: New-ADGroup without -GroupCategory still produces a Security group', async () => {
    const dc = await promotedDc();
    await run(ps(dc), 'New-ADGroup -Name Engineers -GroupScope Global');
    const out = await run(ps(dc), '(Get-ADGroup Engineers).GroupCategory');
    expect(out).toBe('Security');
  });

  it('-GroupCategory Distribution produces a Distribution group, readable back via Get-ADGroup', async () => {
    const dc = await promotedDc();
    await run(ps(dc), 'New-ADGroup -Name AllStaff -GroupScope Global -GroupCategory Distribution');
    const out = await run(ps(dc), '(Get-ADGroup AllStaff).GroupCategory');
    expect(out).toBe('Distribution');
  });

  it('-GroupCategory Security is explicit and equivalent to the default', async () => {
    const dc = await promotedDc();
    await run(ps(dc), 'New-ADGroup -Name Admins2 -GroupScope Global -GroupCategory Security');
    const out = await run(ps(dc), '(Get-ADGroup Admins2).GroupCategory');
    expect(out).toBe('Security');
  });

  it('an invalid -GroupCategory value is rejected with a clear error, not silently defaulted', async () => {
    const dc = await promotedDc();
    const out = await run(ps(dc), 'New-ADGroup -Name Bogus -GroupScope Global -GroupCategory Nonsense');
    expect(out.toLowerCase()).toContain('groupcategory');
    const check = await run(ps(dc), 'Get-ADGroup Bogus');
    expect(check.toLowerCase()).toContain('cannot find an object');
  });

  it('category survives independently of scope — DomainLocal + Distribution combination works', async () => {
    const dc = await promotedDc();
    await run(ps(dc), 'New-ADGroup -Name LocalDist -GroupScope DomainLocal -GroupCategory Distribution');
    const scope = await run(ps(dc), '(Get-ADGroup LocalDist).GroupScope');
    const category = await run(ps(dc), '(Get-ADGroup LocalDist).GroupCategory');
    expect(scope).toBe('DomainLocal');
    expect(category).toBe('Distribution');
  });

  it('pre-existing seeded groups (Domain Admins/Users/Computers) remain Security groups', async () => {
    const dc = await promotedDc();
    const out = await run(ps(dc), '(Get-ADGroup "Domain Admins").GroupCategory');
    expect(out).toBe('Security');
  });
});

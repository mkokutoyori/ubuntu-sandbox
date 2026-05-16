/**
 * Get-Command (gcm) must enumerate the WHOLE cmdlet registry, not a
 * hard-coded stub list, and present canonical PascalCase names supplied
 * by each ICmdlet (open/closed: cmdlets declare `displayName`).
 *
 * Also covers the Measure-Object Count regression: Count must reflect
 * every input object, not just numeric ones, and a single result object
 * must render via the default formatter (Format-List for >4 props).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

async function ps(line: string): Promise<string> {
  const pc = new WindowsPC('windows-pc', 'WIN');
  pc.setCurrentUser('Administrator');
  const { subShell } = PowerShellSubShell.create(pc);
  const r = await subShell.processLine(line);
  return r.output.join('\n');
}

describe('Get-Command — full registry enumeration', () => {
  it('lists well over 100 cmdlets (not the old 20-item stub)', async () => {
    const out = await ps('(Get-Command -CommandType Cmdlet | Measure-Object).Count');
    const n = Number(out.trim());
    expect(n).toBeGreaterThan(100);
  });

  it('surfaces compound-noun cmdlets with canonical casing', async () => {
    for (const name of [
      'Get-LocalGroupMember', 'Get-NetIPAddress', 'Get-ChildItem',
      'Get-CimInstance', 'New-LocalUser', 'Get-ScheduledTask',
    ]) {
      const out = await ps(`Get-Command ${name}`);
      expect(out).toContain(name);
    }
  });

  it('Get-Command Get-* returns multiple Get-* cmdlets', async () => {
    const out = await ps('Get-Command Get-* | Measure-Object');
    const m = out.match(/Count\s*:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(10);
  });

  it('exposes aliases as CommandType=Alias rows', async () => {
    const out = await ps('Get-Command -CommandType Alias | Measure-Object');
    const m = out.match(/Count\s*:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(20);
  });

  it('gcm alias resolves to Get-Command', async () => {
    const out = await ps('gcm Get-Service');
    expect(out).toContain('Get-Service');
    expect(out).toContain('Cmdlet');
  });
});

describe('Measure-Object — Count covers all objects', () => {
  it('counts every object piped from Get-Command', async () => {
    const out = await ps('Get-Command | Measure-Object');
    const m = out.match(/Count\s*:\s*(\d+)/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(100);
  });

  it('counts service objects', async () => {
    const out = await ps('Get-Service | Measure-Object');
    const m = out.match(/Count\s*:\s*(\d+)/);
    expect(Number(m![1])).toBeGreaterThan(0);
  });

  it('still counts plain numbers', async () => {
    const out = await ps('1,2,3,4,5 | Measure-Object');
    expect(out).toMatch(/Count\s*:\s*5/);
  });

  it('renders the result as a Format-List (one prop per line)', async () => {
    const out = await ps('1,2,3 | Measure-Object');
    expect(out).toMatch(/Count\s*:\s*3/);
    expect(out).toMatch(/Average\s*:/);
    // NOT the inline "Count=3; Sum=; ..." hashtable form
    expect(out).not.toMatch(/Count=\d/);
  });
});

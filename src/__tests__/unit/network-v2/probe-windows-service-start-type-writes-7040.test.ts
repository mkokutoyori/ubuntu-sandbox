/**
 * Probe: changing the start type of a Windows service writes event 7040 in the System log, from `sc config` and from `Set-Service`.
 *
 * Reference (rule 8): Microsoft's message table for the Service Control Manager, "Service Events Logging" (learn.microsoft.com, previous-versions
 * windows-server-2008-r2-and-2008, Basic Service Operations): event 7040, provider Service Control Manager, "The start type of the %1 service was
 * changed from %2 to %3.". The words of %2 and %3 (`auto start`, `demand start`, `disabled`, `boot start`) are the ones real logs carry; that page
 * gives the template, not the words, so the words rest on logged examples and are limited to the four a start type maps to (plus `system start`).
 *
 * Measured before the change: `sc.exe config Svc1 start= disabled` and `Set-Service -StartupType Automatic` changed the service and wrote nothing,
 * while starting and stopping the same service wrote 7036. Both interfaces go through WindowsServiceManager.setStartType (one store, two
 * interfaces: rule 3), which now announces the change; the event-log projection writes the entry.
 *
 * Discrimination (git stash push -- src/network src/powershell): 4 of 6 cases fall on the base. Two pass either way: the WITNESS (starting the
 * service writes 7036, so the lab does journal service events at all) and "a change to the same start type writes nothing" (non-regression: the
 * guard against an entry for no change).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;
let cmd: (line: string) => Promise<string>;

beforeEach(async () => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
  cmd = (line) => pc.executeCommand(line);
  await cmd('sc.exe create Svc1 binPath= C:\\svc1.exe start= demand');
});

const LAST_7040 = '(Get-WinEvent -FilterHashtable @{LogName="System"; Id=7040})[0]';

describe('service start type and the System log', () => {
  it('WITNESS: starting the service writes 7036', async () => {
    await cmd('sc.exe start Svc1');
    const out = await ps('(Get-WinEvent -FilterHashtable @{LogName="System"; Id=7036})[0].Message');
    expect(out).toContain('The Svc1 service entered the running state.');
  });

  it('sc config start= disabled writes 7040 from demand start to disabled', async () => {
    await cmd('sc.exe config Svc1 start= disabled');
    expect(await ps(`${LAST_7040}.Message`)).toBe('The start type of the Svc1 service was changed from demand start to disabled.');
  });

  it('Set-Service -StartupType Automatic writes 7040 to auto start', async () => {
    await ps('Set-Service -Name Svc1 -StartupType Automatic');
    expect(await ps(`${LAST_7040}.Message`)).toBe('The start type of the Svc1 service was changed from demand start to auto start.');
  });

  it('the event carries the three parameters of the message', async () => {
    await cmd('sc.exe config Svc1 start= auto');
    const xml = await ps(`${LAST_7040}.ToXml()`);
    expect(xml).toContain('<EventID>7040</EventID>');
    expect(xml).toContain('Service Control Manager');
    expect(xml).toContain("<Data Name='param1'>Svc1</Data>");
    expect(xml).toContain("<Data Name='param2'>demand start</Data>");
    expect(xml).toContain("<Data Name='param3'>auto start</Data>");
  });

  it('a change to the same start type writes nothing', async () => {
    await cmd('sc.exe config Svc1 start= demand');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="System"; Id=7040}).Count')).toContain('No events were found');
  });

  it('two changes write two entries, the newest first', async () => {
    await cmd('sc.exe config Svc1 start= disabled');
    await ps('Set-Service -Name Svc1 -StartupType Manual');
    expect(await ps(`${LAST_7040}.Message`)).toBe('The start type of the Svc1 service was changed from disabled to demand start.');
    expect((await ps('(Get-WinEvent -FilterHashtable @{LogName="System"; Id=7040}).Count')).trim()).toBe('2');
  });
});

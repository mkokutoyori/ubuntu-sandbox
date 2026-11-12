/**
 * Probe: changing the system time of a Windows machine writes event 4616 in the Security log.
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4616 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4616): Version 1, Task 12288 (Security State Change), Keywords 0x8020000000000000, EventData
 * SubjectUserSid / SubjectUserName / SubjectDomainName / SubjectLogonId / PreviousTime / NewTime / ProcessId / ProcessName, and "This event
 * is always logged regardless of the 'Audit Security State Change' sub-category setting". The message text (the page lists the field
 * headings only) follows the neighbouring templates; the closing explanatory paragraph a real machine appends is not on the page and is
 * left out.
 *
 * Measured before the change: `Set-Date -Date (Get-Date).AddMinutes(5)` as Administrator moved the clock and wrote nothing in any log.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 6 cases fall on the base. The WITNESS passes either way: the clock
 * really moves by the requested five minutes, so the event describes a change that happened.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
});

const EVENT = '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4616})[0]';

describe('Set-Date and the Security log', () => {
  it('WITNESS: the clock moves by the five minutes asked', async () => {
    const before = Number((await ps('[long](Get-Date).ToUniversalTime().Subtract([datetime]"1970-01-01").TotalSeconds')).trim());
    await ps('Set-Date -Date (Get-Date).AddMinutes(5)');
    const after = Number((await ps('[long](Get-Date).ToUniversalTime().Subtract([datetime]"1970-01-01").TotalSeconds')).trim());
    expect(after - before).toBeGreaterThanOrEqual(299);
    expect(after - before).toBeLessThanOrEqual(310);
  });

  it('writes 4616 with the descriptor of the reference', async () => {
    await ps('Set-Date -Date (Get-Date).AddMinutes(5)');
    const xml = await ps(`${EVENT}.ToXml()`);
    expect(xml).toContain('<EventID>4616</EventID>');
    expect(xml).toContain('<Version>1</Version>');
    expect(xml).toContain('<Task>12288</Task>');
    expect(xml).toContain('<Keywords>0x8020000000000000</Keywords>');
  });

  it('names the account that changed the time', async () => {
    await ps('Set-Date -Date (Get-Date).AddMinutes(5)');
    const xml = await ps(`${EVENT}.ToXml()`);
    expect(xml).toContain("<Data Name='SubjectUserName'>Administrator</Data>");
    expect(xml).toMatch(/<Data Name='SubjectUserSid'>S-1-5-[\d-]+<\/Data>/);
  });

  it('records the previous and the new time, five minutes apart, with 100 ns precision in UTC', async () => {
    await ps('Set-Date -Date (Get-Date).AddMinutes(5)');
    const xml = await ps(`${EVENT}.ToXml()`);
    const previous = /<Data Name='PreviousTime'>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z)<\/Data>/.exec(xml)?.[1];
    const next = /<Data Name='NewTime'>(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{9}Z)<\/Data>/.exec(xml)?.[1];
    expect(previous).toBeDefined();
    expect(next).toBeDefined();
    const gap = (Date.parse(next!.replace(/\d{6}Z$/, 'Z')) - Date.parse(previous!.replace(/\d{6}Z$/, 'Z'))) / 1000;
    expect(gap).toBeGreaterThanOrEqual(299);
    expect(gap).toBeLessThanOrEqual(310);
  });

  it('names the process that made the change', async () => {
    await ps('Set-Date -Date (Get-Date).AddMinutes(5)');
    const xml = await ps(`${EVENT}.ToXml()`);
    expect(xml).toMatch(/<Data Name='ProcessId'>0x[0-9a-f]+<\/Data>/);
    expect(xml).toContain("<Data Name='ProcessName'>C:\\Program Files\\PowerShell\\7\\pwsh.exe</Data>");
  });

  it('renders the message of the reference headings', async () => {
    await ps('Set-Date -Date (Get-Date).AddMinutes(5)');
    const message = await ps(`${EVENT}.Message`);
    expect(message).toContain('The system time was changed.');
    expect(message).toMatch(/Account Name:\s+Administrator/);
    expect(message).toContain('Process Information:');
    expect(message).toMatch(/Previous Time:\s+\d{4}-/);
    expect(message).toMatch(/New Time:\s+\d{4}-/);
  });
});

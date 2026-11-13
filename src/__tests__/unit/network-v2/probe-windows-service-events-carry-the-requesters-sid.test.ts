/**
 * Probe: the service events a person causes carry that person's SID, and Get-WinEvent can read and filter on it.
 *
 * Reference (rule 8): the Windows event schema, SystemPropertiesType, Security element: its UserID attribute is the SID of the user that caused the
 * event (learn.microsoft.com/windows/win32/wes/eventschema-systempropertiestype-complextype); PowerShell 7.6 Get-WinEvent (official_docs/microsoft/
 * powershell): EventLogRecord.UserId is that SID and -FilterHashtable accepts UserID. Events of the Security log keep an empty <Security/>, as the
 * auditing reference shows for 4698. That 7035, 7040 and 7045 name the requesting user (the "User" column of the Event Viewer) is read from real
 * captures, not from those pages: recorded in TODO.md.
 *
 * Measured before the change: no event carried a SID (<Security/> was empty or absent), so the "User" of 7035 was blank, `UserId` was not a property of
 * what Get-WinEvent returned, and a UserID filter retained nothing at all (it evaluated closed for every event).
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 9 cases fall on the base. Four pass either way: the WITNESS that the administrator has a
 * real SID, the audit event that keeps an empty <Security/>, and the two UserID filters that retain nothing (another SID, and events nobody caused),
 * which the base answered with nothing for every SID.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let pc: WindowsPC;
let ps: (line: string) => Promise<string>;
let adminSid: string;

const first = (log: string, id: number): string => `(Get-WinEvent -FilterHashtable @{LogName="${log}"; Id=${id}})[0]`;

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  pc = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n').trim();
  adminSid = /S-1-5-21-[\d-]+-500/.exec(await pc.executeCommand('whoami /user'))?.[0] ?? '';
});

describe('the requester of a service event', () => {
  it('WITNESS: the administrator has a real SID', () => {
    expect(adminSid).toMatch(/^S-1-5-21-[\d-]+-500$/);
  });

  it('7035 carries the SID of the user who stopped the service', async () => {
    await pc.executeCommand('sc stop Spooler');
    expect(await ps(`${first('System', 7035)}.UserId.Value`)).toBe(adminSid);
  });

  it('7035 shows it in the event XML as <Security UserID>', async () => {
    await pc.executeCommand('sc stop Spooler');
    expect(await ps(`${first('System', 7035)}.ToXml()`)).toContain(`<Security UserID='${adminSid}'/>`);
  });

  it('7040 carries the SID of the user who changed the start type', async () => {
    await pc.executeCommand('sc config Spooler start= demand');
    expect(await ps(`${first('System', 7040)}.UserId.Value`)).toBe(adminSid);
  });

  it('7045 carries the SID of the user who installed the service', async () => {
    await pc.executeCommand('sc create Probe binPath= C:\\Windows\\System32\\probe.exe');
    expect(await ps(`${first('System', 7045)}.UserId.Value`)).toBe(adminSid);
  });

  it('an audit event of the Security log keeps an empty <Security/>', async () => {
    await pc.executeCommand('auditpol /set /subcategory:"Security Group Management" /success:enable');
    await ps('New-LocalGroup -Name Ops | Out-Null');
    const xml = await ps(`${first('Security', 4731)}.ToXml()`);
    expect(xml).toContain('<Security/>');
    expect(xml).not.toContain('UserID=');
  });
});

describe('Get-WinEvent -FilterHashtable UserID', () => {
  it('keeps the events the user caused', async () => {
    await pc.executeCommand('sc stop Spooler');
    const out = await ps(`Get-WinEvent -FilterHashtable @{LogName="System"; UserID="${adminSid}"} | ForEach-Object { $_.Id }`);
    expect(out).toContain('7035');
  });

  it('drops them for another SID', async () => {
    await pc.executeCommand('sc stop Spooler');
    expect(await ps('(Get-WinEvent -FilterHashtable @{LogName="System"; UserID="S-1-5-21-1-2-3-1001"} -ErrorAction SilentlyContinue | Measure-Object).Count')).toBe('0');
  });

  it('does not keep events nobody caused', async () => {
    await pc.executeCommand('sc stop Spooler');
    const out = await ps(`Get-WinEvent -FilterHashtable @{LogName="System"; UserID="${adminSid}"} | ForEach-Object { $_.Id }`);
    expect(out).not.toContain('6005');
  });
});

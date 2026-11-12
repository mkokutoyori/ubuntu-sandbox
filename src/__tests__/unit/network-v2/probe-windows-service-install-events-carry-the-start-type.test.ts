/**
 * Probe: the entries written when a service is installed carry the start type the service was given.
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4697 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4697): EventData ServiceName / ServiceFileName / ServiceType (0x10 own process, 0x20 share process) /
 * ServiceStartType (0 boot, 1 system, 2 automatic, 3 manual, 4 disabled) / ServiceAccount; and the Service Control Manager message table for
 * 7045 ("Service Start Type" in words, `demand start`, `auto start`, `disabled`).
 *
 * Measured before the change: `sc.exe create Svc1 binPath= C:\svc1.exe start= auto` and `New-Service -StartupType Automatic` wrote 7045 with
 * `Service Start Type: demand start` whatever start type was given, and 4697 without the service type, the start type or EventData fields.
 *
 * Discrimination (git stash push -- src/network src/powershell): 6 of 8 cases fall on the base. Two pass either way: the WITNESS (a manual service is
 * written `demand start`, which the old constant already said) and "7045 still names the service and its account" (non-regression).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let ps: (line: string) => Promise<string>;
let cmd: (line: string) => Promise<string>;

beforeEach(() => {
  const pc = new WindowsPC('windows-pc', 'PC1', 0, 0);
  pc.setCurrentUser('Administrator');
  const shell = PowerShellSubShell.create(pc).subShell;
  ps = async (line) => (await shell.processLine(line)).output.join('\n');
  cmd = (line) => pc.executeCommand(line);
});

const SCM = '(Get-WinEvent -FilterHashtable @{LogName="System"; Id=7045})[0]';
const AUDIT = '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4697})[0]';

describe('service installation entries', () => {
  it('WITNESS: a manual service is written demand start', async () => {
    await cmd('sc.exe create Svc1 binPath= C:\\svc1.exe start= demand');
    expect(await ps(`${SCM}.Message`)).toContain('Service Start Type:  demand start');
  });

  it('7045 says auto start for start= auto', async () => {
    await cmd('sc.exe create Svc2 binPath= C:\\svc2.exe start= auto');
    expect(await ps(`${SCM}.Message`)).toContain('Service Start Type:  auto start');
  });

  it('7045 says disabled for start= disabled, and carries it in its data', async () => {
    await cmd('sc.exe create Svc3 binPath= C:\\svc3.exe start= disabled');
    expect(await ps(`${SCM}.Message`)).toContain('Service Start Type:  disabled');
    expect(await ps(`${SCM}.ToXml()`)).toContain("<Data Name='StartType'>disabled</Data>");
  });

  it('New-Service -StartupType Automatic is written auto start as sc create is', async () => {
    await ps('New-Service -Name Svc4 -BinaryPathName C:\\svc4.exe -StartupType Automatic');
    expect(await ps(`${SCM}.Message`)).toContain('Service Start Type:  auto start');
  });

  it('7045 still names the service and its account', async () => {
    await cmd('sc.exe create Svc5 binPath= C:\\svc5.exe start= auto');
    const message = await ps(`${SCM}.Message`);
    expect(message).toContain('Service Name:  Svc5');
    expect(message).toContain('Service File Name:  C:\\svc5.exe');
  });

  it('4697 carries the start type as the reference writes it: 2 for automatic, 3 for manual, 4 for disabled', async () => {
    await cmd('sc.exe create Svc6 binPath= C:\\svc6.exe start= auto');
    expect(await ps(`${AUDIT}.ToXml()`)).toContain("<Data Name='ServiceStartType'>2</Data>");
    await cmd('sc.exe create Svc7 binPath= C:\\svc7.exe start= demand');
    expect(await ps(`${AUDIT}.ToXml()`)).toContain("<Data Name='ServiceStartType'>3</Data>");
    await cmd('sc.exe create Svc8 binPath= C:\\svc8.exe start= disabled');
    expect(await ps(`${AUDIT}.ToXml()`)).toContain("<Data Name='ServiceStartType'>4</Data>");
  });

  it('4697 carries the service name, the file name, the type and the account in its EventData', async () => {
    await cmd('sc.exe create Svc9 binPath= C:\\svc9.exe start= auto');
    const xml = await ps(`${AUDIT}.ToXml()`);
    expect(xml).toContain("<Data Name='ServiceName'>Svc9</Data>");
    expect(xml).toContain("<Data Name='ServiceFileName'>C:\\svc9.exe</Data>");
    expect(xml).toContain("<Data Name='ServiceType'>0x10</Data>");
    expect(xml).toMatch(/<Data Name='ServiceAccount'>[^<]+<\/Data>/);
  });

  it('the message of 4697 shows the type and the start type', async () => {
    await cmd('sc.exe create Svc10 binPath= C:\\svc10.exe start= auto');
    const message = await ps(`${AUDIT}.Message`);
    expect(message).toMatch(/Service Type:\s+0x10/);
    expect(message).toMatch(/Service Start Type:\s+2/);
  });
});

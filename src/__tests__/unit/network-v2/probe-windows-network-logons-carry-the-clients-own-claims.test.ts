/**
 * Probe: a network logon names the client's port and the workstation name the client claims, and a domain controller tells its failures apart.
 *
 * Reference (rule 8): Microsoft's security auditing reference, events 4624, 4625 and 4776 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing): IpPort is the source port of the connection; WorkstationName is the NetBIOS name the client puts in the NTLM
 * authentication message, not a name the server looks up; 4625 SubStatus tells an unknown account (0xC0000064) from a wrong password (0xC000006A);
 * 4776 is written by the computer authoritative for the account, which for a domain account is the domain controller.
 *
 * Measured before the change: the SMB and WinRM servers wrote IpPort as "-" and took WorkstationName from a reverse lookup of the client address (the
 * address itself when no name was known), because the simulated clients sent no name; a known domain account given a wrong password was written as
 * 0xC0000064 (unknown account) because the cause looked only at the local account list; and the controller's own 4776 for a domain account was
 * skipped as "validated elsewhere".
 *
 * Discrimination (git stash push -- src/network src/powershell): 6 of 9 cases fall on the base. Three pass either way: the WITNESS that the drive opens
 * with the right password, and the two unknown-account cases (4625 and 4776 on the controller), which the base answered with 0xC0000064 only because
 * no local account of that name existed.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

const shellOf = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof shellOf>, line: string): Promise<string> => (await sh.processLine(line)).output.join('\n').trim();

const LAST_XML = (id: number): string =>
  `(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}} | Where-Object { $_.Message -match "Logon Type:\\s+3|Source Workstation|Authentication Package:\\s+MICROSOFT" })[0].ToXml()`;

describe('workgroup machines', () => {
  let a: WindowsPC;
  let b: WindowsPC;
  let onA: (line: string) => Promise<string>;

  beforeEach(async () => {
    EquipmentRegistry.getInstance().clear();
    a = new WindowsPC('windows-pc', 'PC-A', 0, 0);
    b = new WindowsPC('windows-pc', 'PC-B', 0, 0);
    const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
    [a, b].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
    const mask = new SubnetMask('255.255.255.0');
    a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
    b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
    a.setCurrentUser('Administrator');
    b.setCurrentUser('Administrator');
    const shellA = shellOf(a);
    onA = (line) => run(shellA, line);
    await onA('New-LocalUser -Name smbuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
    await onA('Add-LocalGroupMember -Group Administrators -Member smbuser');
    await onA('New-Item -ItemType Directory C:\\Share | Out-Null');
    await onA('New-SmbShare -Name Data -Path C:\\Share -FullAccess smbuser | Out-Null');
    await onA('Enable-PSRemoting -Force | Out-Null');
  });

  it('WITNESS: the drive opens with the right password', async () => {
    expect(await b.executeCommand('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser')).toContain('The command completed successfully.');
  });

  it('SMB: the logon names the client port, a real ephemeral port', async () => {
    await b.executeCommand('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser');
    const xml = await onA(LAST_XML(4624));
    expect(xml).toMatch(/<Data Name='IpPort'>\d{4,5}<\/Data>/);
  });

  it('SMB: the workstation is the name the client sent', async () => {
    await b.executeCommand('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser');
    expect(await onA(LAST_XML(4624))).toContain("<Data Name='WorkstationName'>PC-B</Data>");
  });

  it('SMB: a refused logon (4625) carries the same two claims', async () => {
    await b.executeCommand('net use X: \\\\10.0.0.1\\Data wrong /user:smbuser');
    const xml = await onA('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4625})[0].ToXml()');
    expect(xml).toContain("<Data Name='WorkstationName'>PC-B</Data>");
    expect(xml).toMatch(/<Data Name='IpPort'>\d{4,5}<\/Data>/);
  });

  it('WinRM: the logon names the client port and the client name', async () => {
    await run(shellOf(b), 'Invoke-Command -ComputerName 10.0.0.1 -Credential "smbuser:Passw0rd!" -ScriptBlock { hostname } | Out-Null');
    const xml = await onA(LAST_XML(4624));
    expect(xml).toMatch(/<Data Name='IpPort'>\d{4,5}<\/Data>/);
    expect(xml).toContain("<Data Name='WorkstationName'>PC-B</Data>");
  });
});

describe('a domain controller validating a domain account', () => {
  let dc: WindowsServer;
  let client: WindowsPC;
  let onDc: (line: string) => Promise<string>;

  beforeEach(async () => {
    resetCounters();
    resetDeviceCounters();
    Logger.reset();
    dc = new WindowsServer('DC1');
    client = new WindowsPC('windows-pc', 'CLIENT1');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc.getPorts()[0].configureIP(new IPAddress('192.168.40.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.40.30'), mask);
    dc.setCurrentUser('Administrator');
    client.setCurrentUser('Administrator');
    const shellDc = shellOf(dc);
    onDc = (line) => run(shellDc, line);
    await onDc('Install-WindowsFeature AD-Domain-Services');
    await onDc('Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
    await onDc('New-ADUser -Enabled $true -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
    await dc.executeCmdCommand('net share Data=C:\\Data');
    await onDc('auditpol /set /subcategory:"Credential Validation" /success:enable /failure:enable');
  });

  const mount = (user: string, password: string): Promise<string> =>
    client.executeCmdCommand(`net use Z: \\\\192.168.40.10\\Data ${password} /user:${user}`);

  it('a good domain logon writes 4776 on the controller itself (Error Code 0x0)', async () => {
    await mount('LAB\\alice', 'alicepw');
    const out = await onDc('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4776})[0].Message');
    expect(out).toMatch(/Logon Account:\s+alice/);
    expect(out).toMatch(/Error Code:\s+0x0/);
    expect(out).toMatch(/Source Workstation:\s+CLIENT1/);
  });

  it('an unknown domain account is refused with SubStatus 0xC0000064', async () => {
    await mount('LAB\\nobody', 'x');
    const out = await onDc('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4625})[0].Message');
    expect(out).toMatch(/Sub Status:\s+0xC0000064/);
  });

  it('a wrong password for a known domain account stays 0xC000006A', async () => {
    await mount('LAB\\alice', 'wrong');
    const out = await onDc('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4625})[0].Message');
    expect(out).toMatch(/Sub Status:\s+0xC000006A/);
  });

  it('the unknown account is also refused by 4776 with 0xC0000064', async () => {
    await mount('LAB\\nobody', 'x');
    const out = await onDc('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4776})[0].Message');
    expect(out).toMatch(/Error Code:\s+0xC0000064/);
  });
});

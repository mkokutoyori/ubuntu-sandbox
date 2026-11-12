/**
 * Probe: a logon made over SMB is journalled as the network logon it is.
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4624 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4624): LogonType, LogonProcessName, AuthenticationPackageName, WorkstationName, LmPackageName
 * ("NTLM V1", "NTLM V2", "LM"; only when the package is NTLM), KeyLength (typically 128), IpAddress, IpPort. Logon type 3 is a network logon;
 * `NtLmSsp` as the logon process of an NTLM network logon is the value real logs carry (the page leaves it to the 4611 description). Event
 * 4625 carries the same network information and a SubStatus telling the unknown user (0xC0000064) from the wrong password (0xC000006A).
 *
 * Measured before the change, two machines on one switch, a share on PC-A granted to a local user, `net use` from PC-B:
 *  - the good logon was written as 4624 with Logon Type 2 (interactive), Workstation Name PC-A (the server itself), no source address, logon
 *    process User32 and package Negotiate: the SMB server called the password check with its default logon type and no connection details;
 *  - a wrong password wrote nothing from the SMB path, and an unknown user nothing at all (the server skipped the check when the account did
 *    not exist);
 *  - closing the connection wrote no 4634.
 * The server now records the logon itself with the connection's details, for local and domain accounts alike, and the logoff when the
 * connection closes. The client port is not available to the handler (IpPort stays `-`) and WinRM, which has no client details either, is left
 * as it was (TODO.md).
 *
 * Discrimination (git stash push -- src/network src/powershell): 6 of 8 cases fall on the base. Two pass either way: the WITNESS (the mapped drive
 * really opens with the right password, so the entries describe a logon that happened) and "a wrong password is refused" (non-regression of the
 * authentication itself, which this change does not touch).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { IPAddress, SubnetMask } from '@/network/core/types';
import { EquipmentRegistry } from '@/network/equipment/EquipmentRegistry';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

let onA: (line: string) => Promise<string>;
let onB: (line: string) => Promise<string>;

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  const a = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  const b = new WindowsPC('windows-pc', 'PC-B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [a, b].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
  const mask = new SubnetMask('255.255.255.0');
  a.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  a.setCurrentUser('Administrator');
  b.setCurrentUser('Administrator');
  const shellA = PowerShellSubShell.create(a).subShell;
  onA = async (line) => (await shellA.processLine(line)).output.join('\n');
  onB = (line) => b.executeCommand(line);
  await onA('New-LocalUser -Name smbuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  await onA('New-Item -ItemType Directory C:\\Share | Out-Null');
  await onA('New-SmbShare -Name Data -Path C:\\Share -FullAccess smbuser | Out-Null');
});

const LAST = (id: number): string => `(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}})[0]`;
const NETWORK_LOGON = '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4624} | Where-Object { $_.Message -match "Logon Type:\\s+3" })[0]';

describe('SMB logons in the Security log', () => {
  it('WITNESS: the drive opens with the right password', async () => {
    expect(await onB('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser')).toContain('The command completed successfully.');
  });

  it('a good logon is written as a type 3 network logon for the account', async () => {
    await onB('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser');
    const message = await onA(`${NETWORK_LOGON}.Message`);
    expect(message).toMatch(/Logon Type:\s+3/);
    expect(message).toMatch(/Account Name:\s+smbuser/);
  });

  it('names the machine and the address the logon came from, not the server itself', async () => {
    await onB('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser');
    const xml = await onA(`${NETWORK_LOGON}.ToXml()`);
    expect(xml).not.toContain("<Data Name='WorkstationName'>PC-A</Data>");
    expect(xml).toMatch(/<Data Name='WorkstationName'>(PC-B|10\.0\.0\.2)<\/Data>/);
    expect(xml).toContain("<Data Name='IpAddress'>10.0.0.2</Data>");
  });

  it('writes the logon process and the NTLM package the reference describes', async () => {
    await onB('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser');
    const xml = await onA(`${NETWORK_LOGON}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonProcessName'>NtLmSsp</Data>");
    expect(xml).toContain("<Data Name='AuthenticationPackageName'>NTLM</Data>");
    expect(xml).toContain("<Data Name='LmPackageName'>NTLM V2</Data>");
    expect(xml).toContain("<Data Name='KeyLength'>128</Data>");
  });

  it('a wrong password writes 4625 of type 3 with the bad-password sub status', async () => {
    await onB('net use X: \\\\10.0.0.1\\Data WrongPass /user:smbuser');
    const xml = await onA(`${LAST(4625)}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>smbuser</Data>");
    expect(xml).toContain("<Data Name='SubStatus'>0xC000006A</Data>");
    expect(xml).toContain("<Data Name='IpAddress'>10.0.0.2</Data>");
  });

  it('an unknown user writes 4625 with the unknown-user sub status', async () => {
    await onB('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:nobody');
    const xml = await onA(`${LAST(4625)}.ToXml()`);
    expect(xml).toContain("<Data Name='SubStatus'>0xC0000064</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>nobody</Data>");
  });

  it('a wrong password is refused', async () => {
    expect(await onB('net use X: \\\\10.0.0.1\\Data WrongPass /user:smbuser')).toContain('The user name or password is incorrect.');
  });

  it('closing the connection writes 4634 of type 3', async () => {
    await onB('net use X: \\\\10.0.0.1\\Data Passw0rd! /user:smbuser');
    await onB('net use X: /delete /y');
    const xml = await onA(`${LAST(4634)}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>smbuser</Data>");
  });
});

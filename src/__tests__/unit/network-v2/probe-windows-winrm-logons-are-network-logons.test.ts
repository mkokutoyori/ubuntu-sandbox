/**
 * Probe: a logon made over WinRM is journalled as a network logon, with the client's details.
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4624 (learn.microsoft.com, previous-versions windows-10
 * security/threat-protection/auditing/event-4624): LogonType 3 is a network logon; NTLM carries LogonProcessName, AuthenticationPackageName,
 * LmPackageName and KeyLength, Kerberos carries a package of its own and a key length of 0; WorkstationName, IpAddress and IpPort name the client.
 * The SMB server was aligned first (probe-windows-smb-logons-are-network-logons); the WinRM server had the same defect.
 *
 * Measured before the change, two machines on one switch, WinRM enabled on PC-A, `Invoke-Command -ComputerName 10.0.0.1 -Credential "user:password"` from PC-B:
 * WinRmServerHandler checked the password with the default logon type (2, interactive) and no details, so a correct logon was journalled as an
 * interactive one with no client address, a wrong password was journalled as type 2 too, and an unknown account was not journalled at all (the
 * check was skipped when the account did not exist). Closing the session wrote no 4634.
 *
 * Discrimination (git stash push -- src/network src/powershell): 5 of 6 cases fall on the base. The WITNESS passes either way: the remote command
 * runs with the right credential and is refused with the wrong one, so the entries describe a logon that happened or failed.
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

const remote = (user: string, password: string): string =>
  `Invoke-Command -ComputerName 10.0.0.1 -Credential "${user}:${password}" -ScriptBlock { hostname }`;

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
  const shellB = PowerShellSubShell.create(b).subShell;
  onA = async (line) => (await shellA.processLine(line)).output.join('\n');
  onB = async (line) => (await shellB.processLine(line)).output.join('\n');
  await onA('Enable-PSRemoting -Force | Out-Null');
  await onA('New-LocalUser -Name rmuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  await onA('Add-LocalGroupMember -Group Administrators -Member rmuser');
});

const LAST = (id: number): string => `(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}})[0]`;
const NETWORK_LOGON = '(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4624} | Where-Object { $_.Message -match "Logon Type:\\s+3" })[0]';

describe('WinRM logons in the Security log', () => {
  it('WITNESS: the remote command runs with the right credential and is refused with the wrong one', async () => {
    expect((await onB(remote('rmuser', 'Passw0rd!'))).trim()).toBe('PC-A');
    expect(await onB(remote('rmuser', 'nope'))).toContain('Connecting to remote server 10.0.0.1 failed');
  });

  it('a good logon is a type 3 network logon for the account', async () => {
    await onB(remote('rmuser', 'Passw0rd!'));
    const xml = await onA(`${NETWORK_LOGON}.ToXml()`);
    expect(xml).toContain("<Data Name='TargetUserName'>rmuser</Data>");
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
  });

  it('names the address the logon came from, with the NTLM package', async () => {
    await onB(remote('rmuser', 'Passw0rd!'));
    const xml = await onA(`${NETWORK_LOGON}.ToXml()`);
    expect(xml).toContain("<Data Name='IpAddress'>10.0.0.2</Data>");
    expect(xml).toContain("<Data Name='AuthenticationPackageName'>NTLM</Data>");
    expect(xml).toContain("<Data Name='LogonProcessName'>NtLmSsp</Data>");
    expect(xml).not.toContain("<Data Name='WorkstationName'>PC-A</Data>");
  });

  it('a wrong password writes 4625 of type 3 with the bad-password sub status', async () => {
    await onB(remote('rmuser', 'nope'));
    const xml = await onA(`${LAST(4625)}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
    expect(xml).toContain("<Data Name='SubStatus'>0xC000006A</Data>");
    expect(xml).toContain("<Data Name='IpAddress'>10.0.0.2</Data>");
  });

  it('an unknown account writes 4625 with the unknown-user sub status', async () => {
    await onB(remote('ghost', 'Passw0rd!'));
    const xml = await onA(`${LAST(4625)}.ToXml()`);
    expect(xml).toContain("<Data Name='SubStatus'>0xC0000064</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>ghost</Data>");
  });

  it('closing the session writes 4634 of type 3', async () => {
    await onB(remote('rmuser', 'Passw0rd!'));
    const xml = await onA(`${LAST(4634)}.ToXml()`);
    expect(xml).toContain("<Data Name='LogonType'>3</Data>");
    expect(xml).toContain("<Data Name='TargetUserName'>rmuser</Data>");
  });
});

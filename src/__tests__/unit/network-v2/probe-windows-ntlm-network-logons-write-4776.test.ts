/**
 * Probe: an NTLM network logon validated by this machine writes 4776 (Credential Validation).
 *
 * Reference (rule 8): Microsoft's security auditing reference, event 4776 (learn.microsoft.com, previous-versions windows-10 security/threat-protection/
 * auditing/event-4776): written on the computer authoritative for the credentials (the local computer for a local account), for every NTLM validation,
 * success or failure; fields PackageName (always MICROSOFT_AUTHENTICATION_PACKAGE_V1_0), TargetUserName, Workstation, Status (0x0 on success,
 * 0xC0000064 unknown user, 0xC000006A bad password); subcategory Credential Validation, Task 14336, version 0. The message text is the one the page's
 * field list gives (Authentication Package, Logon Account, Source Workstation, Error Code).
 *
 * Measured before the change, WinRM on PC-A, `Invoke-Command -ComputerName 10.0.0.1 -Credential "user:password"` from PC-B: 4624/4625 were written and no
 * 4776 at all, so `Get-WinEvent -FilterHashtable @{LogName='Security';Id=4776}` was empty on a machine that had just validated three credentials.
 *
 * Discrimination (git stash push -- src/network src/powershell): 4 of 5 cases fall on the base. The WITNESS passes either way: the 4625 of the wrong
 * password is written, so the lab does produce a failed NTLM logon.
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
const events = (id: number): Promise<string> =>
  onA(`(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=${id}})[0].Message`);

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
  await onA('auditpol /set /subcategory:"Credential Validation" /success:enable /failure:enable');
  await onA('Enable-PSRemoting -Force | Out-Null');
  await onA('New-LocalUser -Name rmuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  await onA('Add-LocalGroupMember -Group Administrators -Member rmuser');
});

describe('4776 on the machine that validates the credentials', () => {
  it('is written with Status 0x0 for a correct password', async () => {
    await onB(remote('rmuser', 'Passw0rd!'));
    const out = await events(4776);
    expect(out).toContain('The computer attempted to validate the credentials for an account.');
    expect(out).toMatch(/Logon Account:\s+rmuser/);
    expect(out).toMatch(/Error Code:\s+0x0/);
  });

  it('names the source workstation and the fixed authentication package', async () => {
    await onB(remote('rmuser', 'Passw0rd!'));
    const out = await events(4776);
    expect(out).toContain('MICROSOFT_AUTHENTICATION_PACKAGE_V1_0');
    expect(out).toMatch(/Source Workstation:\s+\S+/);
  });

  it('carries 0xC000006A for a wrong password', async () => {
    await onB(remote('rmuser', 'wrong'));
    expect(await events(4776)).toMatch(/Error Code:\s+0xC000006A/);
  });

  it('carries 0xC0000064 for an unknown account', async () => {
    await onB(remote('nobody', 'x'));
    expect(await events(4776)).toMatch(/Error Code:\s+0xC0000064/);
  });

  it('WITNESS: the wrong password is a failed logon (4625)', async () => {
    await onB(remote('rmuser', 'wrong'));
    expect(await events(4625)).toContain('rmuser');
  });
});

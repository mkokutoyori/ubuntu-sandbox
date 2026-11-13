/**
 * Probe: [pscredential]::new(user, secureString) builds a credential, as New-Object PSCredential already did.
 *
 * Reference (rule 8): PowerShell 7.6, System.Management.Automation.PSCredential has the constructor PSCredential(string userName, SecureString
 * password) and `[type]::new(...)` calls a constructor of any type (about_Classes / about_Operators, the `::new` static member).
 *
 * Measured before the change, two workgroup machines, WinRM enabled on PC-A: `$c = [pscredential]::new('rmuser', (ConvertTo-SecureString
 * 'Passw0rd!' -AsPlainText -Force))` left $c empty ($c.UserName was blank), so `Invoke-Command -ComputerName 10.0.0.1 -Credential $c` went out with no
 * identity and was refused, while the same call through New-Object PSCredential worked: two ways to build one credential, one of them silent.
 *
 * Discrimination (git stash push -- src/network src/powershell): 4 of 6 cases fall on the base. Two pass either way: the WITNESS through
 * New-Object, and the refusal of a wrong password (the credential is built, the target refuses it).
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
  const shellB = PowerShellSubShell.create(b).subShell;
  onA = async (line) => (await shellA.processLine(line)).output.join('\n').trim();
  onB = async (line) => (await shellB.processLine(line)).output.join('\n').trim();
  await onA('Enable-PSRemoting -Force | Out-Null');
  await onA('New-LocalUser -Name rmuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  await onA('Add-LocalGroupMember -Group Administrators -Member rmuser');
});

const secret = (plain: string): string => `(ConvertTo-SecureString "${plain}" -AsPlainText -Force)`;

describe('[pscredential]::new', () => {
  it('WITNESS: New-Object PSCredential builds a credential that remoting accepts', async () => {
    await onB(`$c = New-Object System.Management.Automation.PSCredential("rmuser", ${secret('Passw0rd!')})`);
    expect(await onB('Invoke-Command -ComputerName 10.0.0.1 -Credential $c -ScriptBlock { hostname }')).toContain('PC-A');
  });

  it('keeps the user name', async () => {
    await onB(`$c = [pscredential]::new("rmuser", ${secret('Passw0rd!')})`);
    expect(await onB('$c.UserName')).toBe('rmuser');
  });

  it('is accepted by Invoke-Command -Credential', async () => {
    await onB(`$c = [pscredential]::new("rmuser", ${secret('Passw0rd!')})`);
    expect(await onB('Invoke-Command -ComputerName 10.0.0.1 -Credential $c -ScriptBlock { hostname }')).toContain('PC-A');
  });

  it('works under the full type name', async () => {
    await onB(`$c = [System.Management.Automation.PSCredential]::new("rmuser", ${secret('Passw0rd!')})`);
    expect(await onB('$c.UserName')).toBe('rmuser');
  });

  it('a wrong password is built and then refused by the target', async () => {
    await onB(`$c = [pscredential]::new("rmuser", ${secret('wrong')})`);
    expect(await onB('Invoke-Command -ComputerName 10.0.0.1 -Credential $c -ScriptBlock { hostname }')).not.toContain('PC-A');
  });

  it('the successful logon is the one of the credential, not an anonymous one', async () => {
    await onB(`$c = [pscredential]::new("rmuser", ${secret('Passw0rd!')})`);
    await onB('Invoke-Command -ComputerName 10.0.0.1 -Credential $c -ScriptBlock { hostname } | Out-Null');
    expect(await onA('(Get-WinEvent -FilterHashtable @{LogName="Security"; Id=4624} | Where-Object { $_.Message -match "Logon Type:\\s+3" })[0].Message')).toMatch(/Account Name:\s+rmuser/);
  });
});

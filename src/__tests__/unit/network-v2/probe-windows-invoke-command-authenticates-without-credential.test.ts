/**
 * Probe: Invoke-Command without -Credential authenticates the caller's own identity, and is refused where none exists.
 *
 * Reference (rule 8): about_Remote_Requirements / Invoke-Command documentation (learn.microsoft.com, PowerShell 7.6): without -Credential the
 * current user's identity is negotiated; between workgroup machines no Kerberos identity exists and the connection is refused. Test-WSMan
 * sends an anonymous Identify and needs no identity.
 *
 * Measured before the change, two workgroup machines on one switch, WinRM enabled on PC-A: `Invoke-Command -ComputerName 10.0.0.1 -ScriptBlock { hostname }`
 * from PC-B ran the block and answered PC-A. The provider only opened a TCP connection to 5985 and never authenticated, so a remote command ran
 * with no logon and no refusal. Security criteria fail closed.
 *
 * Discrimination (git stash push -- src/network src/powershell): 1 of 4 cases falls on the base (the refusal). The others pass either way: the absent
 * 4624 is a non-regression (the base opened a bare TCP connection and logged nothing), the credentialed call and Test-WSMan are WITNESSES.
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
let pcA: WindowsPC;

beforeEach(async () => {
  EquipmentRegistry.getInstance().clear();
  pcA = new WindowsPC('windows-pc', 'PC-A', 0, 0);
  const b = new WindowsPC('windows-pc', 'PC-B', 0, 0);
  const sw = new GenericSwitch('switch-generic', 'sw', 8, 0, 0);
  [pcA, b].forEach((device, index) => new Cable(`c${index}`).connect(device.getPorts()[0], sw.getPorts()[index]));
  const mask = new SubnetMask('255.255.255.0');
  pcA.getPorts()[0].configureIP(new IPAddress('10.0.0.1'), mask);
  b.getPorts()[0].configureIP(new IPAddress('10.0.0.2'), mask);
  pcA.setCurrentUser('Administrator');
  b.setCurrentUser('Administrator');
  const shellA = PowerShellSubShell.create(pcA).subShell;
  const shellB = PowerShellSubShell.create(b).subShell;
  onA = async (line) => (await shellA.processLine(line)).output.join('\n');
  onB = async (line) => (await shellB.processLine(line)).output.join('\n');
  await onA('Enable-PSRemoting -Force | Out-Null');
  await onA('New-LocalUser -Name rmuser -Password (ConvertTo-SecureString "Passw0rd!" -AsPlainText -Force) | Out-Null');
  await onA('Add-LocalGroupMember -Group Administrators -Member rmuser');
});

describe('Invoke-Command without -Credential between workgroup machines', () => {
  it('does not run the script block', async () => {
    const out = await onB('Invoke-Command -ComputerName 10.0.0.1 -ScriptBlock { hostname }');
    expect(out).not.toContain('PC-A');
  });

  it('writes no successful network logon on the target', async () => {
    await onB('Invoke-Command -ComputerName 10.0.0.1 -ScriptBlock { hostname }');
    const out = await onA('Get-WinEvent -FilterHashtable @{LogName="Security";Id=4624} -ErrorAction SilentlyContinue | Out-String');
    expect(out).not.toContain('10.0.0.2');
  });

  it('WITNESS: the same call with a valid credential runs', async () => {
    const out = await onB('Invoke-Command -ComputerName 10.0.0.1 -Credential "rmuser:Passw0rd!" -ScriptBlock { hostname }');
    expect(out).toContain('PC-A');
  });

  it('WITNESS: Test-WSMan identifies the target anonymously', async () => {
    const out = await onB('Test-WSMan -ComputerName 10.0.0.1');
    expect(out).toContain('wsmid');
  });
});

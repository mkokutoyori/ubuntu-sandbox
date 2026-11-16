/**
 * Probe: Get-WinEvent -ComputerName reads the event log of the named machine.
 *
 * Reference (rule 8): Get-WinEvent documentation (PowerShell 7.6): -ComputerName "gets events from the event logs on the specified computer", -Credential names the
 * account used; the cmdlet reads through the Event Log remote protocol (RPC), which the simulator does not carry: the call is admitted through the same authenticated
 * WinRM logon as Invoke-Command (a real 4624 on the target, a refusal without a valid identity), then reads the target's own event log store. The transport differs
 * from the real one; the answer (the target's events, MachineName set to the target) does not.
 *
 * Measured before the change: -ComputerName was read and ignored, so `Get-WinEvent -ComputerName 10.0.0.1 -FilterHashtable @{LogName='Application'; ProviderName='Marker'}`
 * from PC-B answered with PC-B's own (empty) log and never contacted PC-A.
 *
 * Discrimination (git stash push -- src/network src/powershell): 3 of 5 cases fall on the base (the remote event, MachineName, the 4624). The refusal case and the
 * local-name witness pass either way (the base answered nothing remote, and local is local).
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


const MARK = 'eventcreate /l Application /so Marker /id 77 /t INFORMATION /d "written on PC-A"';
const REMOTE = "Get-WinEvent -ComputerName 10.0.0.1 -Credential \"rmuser:Passw0rd!\" -FilterHashtable @{LogName='Application'; ProviderName='Marker'}";

describe('Get-WinEvent -ComputerName', () => {
  it('returns the event written on the target', async () => {
    await onA(MARK);
    expect(await onB(`${REMOTE} | ForEach-Object { $_.Message }`)).toContain('written on PC-A');
  });

  it('names the target machine', async () => {
    await onA(MARK);
    expect((await onB(`${REMOTE} | ForEach-Object { $_.MachineName }`)).trim()).toBe('PC-A');
  });

  it('leaves a network logon on the target', async () => {
    await onA(MARK);
    await onB(REMOTE);
    expect(await onA('Get-WinEvent -FilterHashtable @{LogName="Security";Id=4624} -ErrorAction SilentlyContinue | Out-String')).toContain('10.0.0.2');
  });

  it('is refused without a valid identity', async () => {
    await onA(MARK);
    const out = await onB("Get-WinEvent -ComputerName 10.0.0.1 -FilterHashtable @{LogName='Application'; ProviderName='Marker'}");
    expect(out).not.toContain('written on PC-A');
  });

  it('WITNESS: a local name reads the local log', async () => {
    await onB('eventcreate /l Application /so Marker /id 78 /t INFORMATION /d "written on PC-B"');
    expect(await onB("Get-WinEvent -ComputerName localhost -FilterHashtable @{LogName='Application'; ProviderName='Marker'} | ForEach-Object { $_.Message }")).toContain('written on PC-B');
  });
});

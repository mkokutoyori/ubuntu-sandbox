/*
 * Probe: Set-ADComputer had no -SamAccountName: a computer account could not be renamed and 4781 could not be written for it.
 * Source (rule 8): Microsoft Learn 4781(S) page (read in this session): "For computer accounts, this event generates only on domain
 * controllers", names OldTargetUserName / NewTargetUserName (a computer's sAMAccountName ends with "$"), User Account Management;
 * Set-ADComputer.md declares -SamAccountName. A computer object carries no objectSid in this directory, so the SID is not asserted.
 *
 * Discriminated with git stash on src: 4 of 4 fall before the fix, the witness included: Get-ADComputer exposed no SamAccountName at
 * all (a real computer object carries it, and Identity resolves by it). Nothing here passes either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';

beforeEach(() => { resetCounters(); resetDeviceCounters(); Logger.reset(); });

const run = async (d: WindowsServer, l: string) => (await PowerShellSubShell.create(d).subShell.processLine(l)).output.join('\n').trim();

async function dc() {
  const server = new WindowsServer('DC1');
  const members = [new WindowsServer('SRV1'), new WindowsServer('SRV2')];
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const mask = new SubnetMask('255.255.255.0');
  [server, ...members].forEach((machine, index) => {
    new Cable(`c${index}`).connect(machine.getPorts()[0], sw.getPorts()[index]);
    machine.getPorts()[0].configureIP(new IPAddress(`192.168.40.${10 + index * 10}`), mask);
    machine.setCurrentUser('Administrator');
  });
  await run(server, 'Install-WindowsFeature AD-Domain-Services');
  await run(server, 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(server, 'auditpol /set /subcategory:"User Account Management" /success:enable');
  for (const member of members) await run(member, 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.40.10');
  return server;
}

const xmlOf = (server: WindowsServer) =>
  server.executeCmdCommand('wevtutil qe Security /q:"*[System[EventID=4781]]" /rd:true /f:xml').then(String);
const data = (xml: string, name: string) => new RegExp(`<Data Name='${name}'>([^<]*)</Data>`).exec(xml)?.[1] ?? '';

describe('Set-ADComputer -SamAccountName renames the computer account and writes 4781', () => {
  it('witness: the computer account exists under its first name', async () => {
    expect(await run(await dc(), '(Get-ADComputer -Identity SRV1).SamAccountName')).toBe('SRV1$');
  });

  it('the account answers to its new name', async () => {
    const server = await dc();
    await run(server, 'Set-ADComputer -Identity SRV1 -SamAccountName "SRV9$"');
    expect(await run(server, '(Get-ADComputer -Identity SRV9).SamAccountName')).toBe('SRV9$');
  });

  it('writes 4781 on the domain controller with the old and the new name', async () => {
    const server = await dc();
    await run(server, 'Set-ADComputer -Identity SRV1 -SamAccountName "SRV9$"');
    const xml = await xmlOf(server);
    expect(data(xml, 'OldTargetUserName')).toBe('SRV1$');
    expect(data(xml, 'NewTargetUserName')).toBe('SRV9$');
    expect(data(xml, 'SubjectUserName')).toBe('Administrator');
  });

  it('refuses a name another account holds, and writes nothing', async () => {
    const server = await dc();
    expect(await run(server, 'Set-ADComputer -Identity SRV1 -SamAccountName "SRV2$"')).toContain('already exists');
    expect(await xmlOf(server)).not.toContain('OldTargetUserName');
  });
});

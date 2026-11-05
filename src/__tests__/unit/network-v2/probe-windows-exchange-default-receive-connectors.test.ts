/*
 * Probe: Install-ExchangeServer -Roles Mailbox leaves the server with the two Frontend receive connectors a real
 * Exchange setup creates ("Default Frontend <server>" on 25, "Client Frontend <server>" on 587), and
 * Remove-ReceiveConnector exists to take one away. Measured before: port 25 was closed after setup until an admin
 * typed New-ReceiveConnector, and no Remove-ReceiveConnector cmdlet existed.
 * Discriminated with git stash on src: 4 of 6 fall before the fix; the witness (nc to 25 before the install is
 * refused) and the unknown-name error (the cmdlet is absent, the message still names the object) pass either way.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';

beforeEach(() => { resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset(); resetExchangeOrganizations(); });

async function lab() {
  const dc = new WindowsServer('MX1');
  const pc = new LinuxPC('linux-pc', 'PC');
  new Cable('c').connect(dc.getPort('eth0')!, pc.getPort('eth0')!);
  dc.setCurrentUser('Administrator');
  const sh = PowerShellSubShell.create(dc).subShell;
  const run = async (line: string) => (await sh.processLine(line)).output.join('\n');
  await run('New-NetIPAddress -InterfaceAlias "Ethernet 0" -IPAddress 10.7.0.25 -PrefixLength 24');
  await pc.executeCommand('ip addr add 10.7.0.2/24 dev eth0');
  await pc.executeCommand('ip link set eth0 up');
  await run('Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run('Install-ADDSForest -DomainName "mx.lan" -DomainNetBiosName "MX" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mx2026!" -AsPlainText -Force) -Force:$true');
  return { run, pc };
}

describe('default receive connectors', () => {
  it('witness: 25 is closed before Exchange is installed', async () => {
    const { pc } = await lab();
    expect(await pc.executeCommand('nc -zv -w 2 10.7.0.25 25')).toMatch(/refused|failed/i);
  });

  it('Install-ExchangeServer opens 25 without any New-ReceiveConnector', async () => {
    const { run, pc } = await lab();
    await run('Install-ExchangeServer -Roles Mailbox -OrganizationName "Mx"');
    expect(await pc.executeCommand('nc -zv -w 2 10.7.0.25 25')).toMatch(/succeeded|open/i);
  });

  it('Install-ExchangeServer opens the client submission port 587', async () => {
    const { run, pc } = await lab();
    await run('Install-ExchangeServer -Roles Mailbox -OrganizationName "Mx"');
    expect(await pc.executeCommand('nc -zv -w 2 10.7.0.25 587')).toMatch(/succeeded|open/i);
  });

  it('Get-ReceiveConnector lists both Frontend connectors by their Exchange names', async () => {
    const { run } = await lab();
    await run('Install-ExchangeServer -Roles Mailbox -OrganizationName "Mx"');
    const out = await run('Get-ReceiveConnector');
    expect(out).toContain('Default Frontend MX1');
    expect(out).toContain('Client Frontend MX1');
  });

  it('Remove-ReceiveConnector closes the port it was bound to', async () => {
    const { run, pc } = await lab();
    await run('Install-ExchangeServer -Roles Mailbox -OrganizationName "Mx"');
    await run('Remove-ReceiveConnector -Identity "Default Frontend MX1"');
    expect(await pc.executeCommand('nc -zv -w 2 10.7.0.25 25')).toMatch(/refused|failed/i);
  });

  it('Remove-ReceiveConnector of an unknown name is an error', async () => {
    const { run } = await lab();
    await run('Install-ExchangeServer -Roles Mailbox -OrganizationName "Mx"');
    expect(await run('Remove-ReceiveConnector -Identity "nope"')).toContain("couldn't be found");
  });
});

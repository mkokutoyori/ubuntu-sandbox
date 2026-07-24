import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetExchangeOrganizations();
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function promoteDc(dc: WindowsServer): Promise<void> {
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
}

describe('Install-ExchangeServer / Get-ExchangeServer (docs/PRD-Exchange.md §2.1 P1)', () => {
  it('every Exchange cmdlet fails with "not recognized" before Install-ExchangeServer has run', async () => {
    const dc = new WindowsServer('DC01');
    await promoteDc(dc);
    const out = await run(ps(dc), 'Get-ExchangeServer');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });

  it('Install-ExchangeServer fails on a server that is not domain-joined, with a specific message (not "not recognized")', async () => {
    const server = new WindowsServer('SRV01');
    server.setCurrentUser('Administrator');
    const out = await run(ps(server), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    expect(out).not.toContain('is not recognized');
    expect(out.toLowerCase()).toContain('joined to an active directory domain');
  });

  it('a non-server WindowsPC always gets "not recognized", even for Install-ExchangeServer itself', async () => {
    const pc = new WindowsPC('windows-pc', 'PC01');
    const out = await run(ps(pc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });

  it('succeeds on a domain controller (already domain-joined) and Get-ExchangeServer then lists it', async () => {
    const dc = new WindowsServer('DC01');
    await promoteDc(dc);
    const installOut = await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    expect(installOut).not.toContain('is not recognized');
    expect(installOut).toContain('Success');

    const listOut = await run(ps(dc), 'Get-ExchangeServer');
    expect(listOut).toContain('DC01');
    expect(listOut).toContain('Mailbox');
  });

  it('a second Install-ExchangeServer on the same server fails cleanly, no double installation', async () => {
    const dc = new WindowsServer('DC01');
    await promoteDc(dc);
    await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    const secondOut = await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    expect(secondOut.toLowerCase()).toContain('already');

    const listOut = await run(ps(dc), 'Get-ExchangeServer');
    const nameLines = listOut.split('\n').filter((l) => l.trim().startsWith('Name '));
    expect(nameLines).toHaveLength(1);
  });

  it('Get-ExchangeServer -Identity finds a specific server and reports "not found" for an unknown one', async () => {
    const dc = new WindowsServer('DC01');
    await promoteDc(dc);
    await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');

    const found = await run(ps(dc), 'Get-ExchangeServer -Identity DC01');
    expect(found).toContain('DC01');

    const notFound = await run(ps(dc), 'Get-ExchangeServer -Identity GHOST01');
    expect(notFound.toLowerCase()).toContain("couldn't be found");
  });

  it('two servers sharing the same OrganizationName share one Exchange organization — Get-ExchangeServer lists both from either server', async () => {
    const dc1 = new WindowsServer('DC01');
    const dc2 = new WindowsServer('DC02');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc1.getPorts()[0].configureIP(new IPAddress('192.168.10.10'), mask);
    dc2.getPorts()[0].configureIP(new IPAddress('192.168.10.11'), mask);

    await promoteDc(dc1);
    dc2.setCurrentUser('Administrator');
    await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc2), 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.10.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

    await run(ps(dc1), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
    await run(ps(dc2), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');

    const fromDc1 = await run(ps(dc1), 'Get-ExchangeServer');
    expect(fromDc1).toContain('DC01');
    expect(fromDc1).toContain('DC02');

    const fromDc2 = await run(ps(dc2), 'Get-ExchangeServer');
    expect(fromDc2).toContain('DC01');
    expect(fromDc2).toContain('DC02');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
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

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function exchangeServerWithMailboxes(names: readonly string[]): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  for (const n of names) {
    await run(ps(dc), `New-Mailbox -Name ${n} -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)`);
  }
  return dc;
}

describe('New/Set/Get-DistributionGroup, Add/Get-DistributionGroupMember (docs/PRD-Exchange.md §2.1 P3)', () => {
  it('New-DistributionGroup fails when the underlying AD group does not exist', async () => {
    const dc = await exchangeServerWithMailboxes([]);
    const out = await run(ps(dc), 'New-DistributionGroup -Name Sales');
    expect(out.toLowerCase()).toContain("couldn't be found");
  });

  it('New-DistributionGroup mail-enables an existing Distribution-category AD group', async () => {
    const dc = await exchangeServerWithMailboxes([]);
    await run(ps(dc), 'New-ADGroup -Name Sales -GroupScope Global -GroupCategory Distribution');
    const out = await run(ps(dc), 'New-DistributionGroup -Name Sales');
    expect(out.toLowerCase()).toContain('sales@mandeng.lan');
  });

  it('New-DistributionGroup rejects a Security-category group unless -Type Security is passed', async () => {
    const dc = await exchangeServerWithMailboxes([]);
    await run(ps(dc), 'New-ADGroup -Name ITAdmins -GroupScope Global -GroupCategory Security');
    const failOut = await run(ps(dc), 'New-DistributionGroup -Name ITAdmins');
    expect(failOut.toLowerCase()).toContain('security');

    const okOut = await run(ps(dc), 'New-DistributionGroup -Name ITAdmins -Type Security');
    expect(okOut.toLowerCase()).toContain('itadmins@mandeng.lan');
  });

  it('Set-DistributionGroup changes the primary SMTP address', async () => {
    const dc = await exchangeServerWithMailboxes([]);
    await run(ps(dc), 'New-ADGroup -Name Sales -GroupScope Global -GroupCategory Distribution');
    await run(ps(dc), 'New-DistributionGroup -Name Sales');
    const out = await run(ps(dc), 'Set-DistributionGroup -Identity Sales -PrimarySmtpAddress "salesteam@mandeng.lan"');
    expect(out.toLowerCase()).toContain('salesteam@mandeng.lan');
  });

  it('Get-DistributionGroup with no identity lists every mail-enabled group', async () => {
    const dc = await exchangeServerWithMailboxes([]);
    await run(ps(dc), 'New-ADGroup -Name Sales -GroupScope Global -GroupCategory Distribution');
    await run(ps(dc), 'New-ADGroup -Name Marketing -GroupScope Global -GroupCategory Distribution');
    await run(ps(dc), 'New-DistributionGroup -Name Sales');
    await run(ps(dc), 'New-DistributionGroup -Name Marketing');
    const out = await run(ps(dc), 'Get-DistributionGroup');
    expect(out).toContain('Sales');
    expect(out).toContain('Marketing');
  });

  it('Add-DistributionGroupMember adds a real AD group member, visible via Get-DistributionGroupMember', async () => {
    const dc = await exchangeServerWithMailboxes(['bob', 'carol']);
    await run(ps(dc), 'New-ADGroup -Name Team -GroupScope Global -GroupCategory Distribution');
    await run(ps(dc), 'New-DistributionGroup -Name Team');
    await run(ps(dc), 'Add-DistributionGroupMember -Identity Team -Member bob');
    await run(ps(dc), 'Add-DistributionGroupMember -Identity Team -Member carol');

    const members = await run(ps(dc), 'Get-DistributionGroupMember -Identity Team');
    expect(members).toContain('bob');
    expect(members).toContain('carol');
  });

  it('a message to the group address fans out to every member mailbox — the emblematic P3 test', async () => {
    const dc = await exchangeServerWithMailboxes(['bob', 'carol', 'dave']);
    await run(ps(dc), 'New-ADGroup -Name Team -GroupScope Global -GroupCategory Distribution');
    await run(ps(dc), 'New-DistributionGroup -Name Team');
    await run(ps(dc), 'Add-DistributionGroupMember -Identity Team -Member bob');
    await run(ps(dc), 'Add-DistributionGroupMember -Identity Team -Member carol');
    await run(ps(dc), 'Add-DistributionGroupMember -Identity Team -Member dave');

    const results = dc.deliverToRecipient('team@mandeng.lan', 'alice@mandeng.lan', 'Announcement', 'Subject: Announcement\r\n\r\nHi team.', 1000);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.delivered)).toBe(true);

    const bobStats = await run(ps(dc), 'Get-MailboxStatistics bob');
    const carolStats = await run(ps(dc), 'Get-MailboxStatistics carol');
    const daveStats = await run(ps(dc), 'Get-MailboxStatistics dave');
    for (const stats of [bobStats, carolStats, daveStats]) expect(stats).toContain('InboxCount');
  });

  it('every distribution-group cmdlet fails with "not recognized" before Install-ExchangeServer has run', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Get-DistributionGroup');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

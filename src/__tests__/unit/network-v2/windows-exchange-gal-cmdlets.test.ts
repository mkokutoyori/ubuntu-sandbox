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

async function exchangeServer(): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  return dc;
}

describe('Get-GlobalAddressList (docs/PRD-Exchange.md §2.1 P4)', () => {
  it('lists mailboxes and mail-enabled groups together', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name bob -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    await run(ps(dc), 'New-ADGroup -Name Sales -GroupScope Global -GroupCategory Distribution');
    await run(ps(dc), 'New-DistributionGroup -Name Sales');

    const out = await run(ps(dc), 'Get-GlobalAddressList');
    expect(out).toContain('bob');
    expect(out).toContain('Sales');
  });

  it('fails with "not recognized" before Install-ExchangeServer has run', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Get-GlobalAddressList');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

describe('resolveRecipientAddress()/deliverToRecipient() — sending by display name, not just SMTP address (§2.1 P4)', () => {
  it('a message sent to a bare SAM account name resolves to the same mailbox as the literal address would', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name bob -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');

    const byName = dc.deliverToRecipient('bob', 'alice@mandeng.lan', 'Hi', 'Subject: Hi\r\n\r\nHello.', 1000);
    const byAddress = dc.deliverToRecipient('bob@mandeng.lan', 'alice@mandeng.lan', 'Hi again', 'Subject: Hi again\r\n\r\nHello.', 2000);

    expect(byName[0].delivered).toBe(true);
    expect(byAddress[0].delivered).toBe(true);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(2);
  });

  it('an unresolvable display name fails cleanly rather than delivering to a made-up address', async () => {
    const dc = await exchangeServer();
    const results = dc.deliverToRecipient('nobody-by-this-name', 'alice@mandeng.lan', 'Hi', 'body', 1000);
    expect(results).toHaveLength(1);
    expect(results[0].delivered).toBe(false);
    expect(results[0].reason).toBe('not-found');
  });
});

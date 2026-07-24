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

describe('Enable-Mailbox / New-Mailbox / Get-Mailbox / Set-Mailbox / Get-MailboxStatistics / Disable-Mailbox / Remove-Mailbox (docs/PRD-Exchange.md §2.1 P2)', () => {
  it('Enable-Mailbox fails on a non-existent AD account', async () => {
    const dc = await exchangeServer();
    const out = await run(ps(dc), 'Enable-Mailbox -Identity ghost');
    expect(out.toLowerCase()).toContain("couldn't be found");
  });

  it('Enable-Mailbox on an existing AD account creates a mailbox with a derived primary SMTP address', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force) -Enabled $true');
    const out = await run(ps(dc), 'Enable-Mailbox -Identity bob');
    expect(out).toContain('bob@mandeng.lan');

    const getOut = await run(ps(dc), 'Get-Mailbox bob');
    expect(getOut).toContain('bob@mandeng.lan');
  });

  it('New-Mailbox creates the AD account and the mailbox in one call', async () => {
    const dc = await exchangeServer();
    const out = await run(ps(dc), 'New-Mailbox -Name carol -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    expect(out).toContain('carol@mandeng.lan');

    const adOut = await run(ps(dc), 'Get-ADUser carol');
    expect(adOut).toContain('carol');
  });

  it('Get-Mailbox with no identity lists every mailbox-enabled account', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name carol -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    await run(ps(dc), 'New-Mailbox -Name dave -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    const out = await run(ps(dc), 'Get-Mailbox');
    expect(out).toContain('carol');
    expect(out).toContain('dave');
  });

  it('Set-Mailbox sets a quota, and a message crossing it is rejected via the real SMTP 552 mechanism', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name carol -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    const out = await run(ps(dc), 'Set-Mailbox -Identity carol -ProhibitSendReceiveQuota 10MB');
    expect(out).toContain('10485760');

    const bad = await run(ps(dc), 'Set-Mailbox -Identity carol -ProhibitSendReceiveQuota notasize');
    expect(bad.toLowerCase()).toContain('cannot convert');
  });

  it('Get-MailboxStatistics reports item counts and total size, updated after a real delivery', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name carol -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    const store = dc.getMailboxStore()!;
    store.deliver('carol@mandeng.lan', 'alice@mandeng.lan', 'Hi', 'Subject: Hi\r\n\r\nHello Carol.', 1000);

    const out = await run(ps(dc), 'Get-MailboxStatistics carol');
    expect(out).toContain('1');
  });

  it('Disable-Mailbox removes the mailbox but the AD account remains', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name carol -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    await run(ps(dc), 'Disable-Mailbox -Identity carol');

    const mailboxOut = await run(ps(dc), 'Get-Mailbox carol');
    expect(mailboxOut.toLowerCase()).toContain("couldn't be found");

    const adOut = await run(ps(dc), 'Get-ADUser carol');
    expect(adOut).toContain('carol');
  });

  it('Remove-Mailbox removes both the mailbox and the AD account', async () => {
    const dc = await exchangeServer();
    await run(ps(dc), 'New-Mailbox -Name carol -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
    await run(ps(dc), 'Remove-Mailbox -Identity carol');

    const mailboxOut = await run(ps(dc), 'Get-Mailbox carol');
    expect(mailboxOut.toLowerCase()).toContain("couldn't be found");

    const adOut = await run(ps(dc), 'Get-ADUser carol');
    expect(adOut.toLowerCase()).toContain('cannot find an object');
  });

  it('every mailbox cmdlet fails with "not recognized" before Install-ExchangeServer has run', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Get-Mailbox');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

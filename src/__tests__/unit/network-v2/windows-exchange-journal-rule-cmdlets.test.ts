import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import { SMTP_PORT } from '@/network/smtp/SmtpServer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetExchangeOrganizations();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function exchangeServerWithMailboxes(...names: string[]): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.configureInterface('eth0', new IPAddress('10.0.5.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  for (const name of names) {
    await run(ps(dc), `New-Mailbox -Name ${name} -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)`);
  }
  return dc;
}

describe('New/Get-JournalRule (docs/PRD-Exchange.md §2.1 P10) — a system Transport Rule, not a second mechanism', () => {
  it('creates a system rule with empty conditions (Scope Global) and a BlindCopyTo action to the journal mailbox', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'journal');
    const out = await run(ps(dc), 'New-JournalRule -JournalEmailAddress "journal@mandeng.lan" -Scope Global');
    expect(out).toContain('Journal Rule');
    const rule = dc.getJournalRule();
    expect(rule).not.toBeNull();
    expect(rule!.system).toBe(true);
    expect(rule!.conditions).toEqual([]);
    expect(rule!.actions).toEqual([{ kind: 'BlindCopyTo', address: 'journal@mandeng.lan' }]);
  });

  it('rejects a scope other than Global', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    const out = await run(ps(dc), 'New-JournalRule -JournalEmailAddress "journal@mandeng.lan" -Scope PerUser');
    expect(out.toLowerCase()).toContain('does not belong to the set');
    expect(dc.getJournalRule()).toBeNull();
  });

  it('only one Global journal rule is allowed per organization', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    await run(ps(dc), 'New-JournalRule -JournalEmailAddress "journal@mandeng.lan" -Scope Global');
    const out = await run(ps(dc), 'New-JournalRule -JournalEmailAddress "other-journal@mandeng.lan" -Scope Global');
    expect(out.toLowerCase()).toContain('already exists');
  });

  it('Get-JournalRule fails with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Get-JournalRule');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

describe('The journal rule really applies to live SMTP traffic (docs/PRD-Exchange.md §8, emblematic P10 test)', () => {
  it('a message delivered normally to its real recipient is also silently BCC\'d to the journal mailbox', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'journal');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.5.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
    await run(ps(dc), 'New-JournalRule -JournalEmailAddress "journal@mandeng.lan" -Scope Global');

    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.5.10', '10.0.5.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nHello Bob.');

    expect(final?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(dc.getMailboxStore()!.get('journal')!.folders.Inbox).toHaveLength(1);
    expect(dc.getMailboxStore()!.get('journal')!.folders.Inbox[0].subject).toBe('hi');
  });

  it('every message is journaled, even one that also matches an ordinary Transport Rule', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'journal');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.5.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
    await run(ps(dc), 'New-JournalRule -JournalEmailAddress "journal@mandeng.lan" -Scope Global');
    await run(ps(dc), 'New-TransportRule -Name Disclaimer -ApplyHtmlDisclaimerText "Confidential."');

    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.5.10', '10.0.5.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nHello Bob.');

    expect(final?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(dc.getMailboxStore()!.get('journal')!.folders.Inbox).toHaveLength(1);
  });
});

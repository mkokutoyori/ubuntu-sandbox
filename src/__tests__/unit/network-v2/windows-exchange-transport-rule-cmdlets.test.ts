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
  dc.configureInterface('eth0', new IPAddress('10.0.3.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  for (const name of names) {
    await run(ps(dc), `New-Mailbox -Name ${name} -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)`);
  }
  return dc;
}

function sendMail(dc: WindowsServer, client: LinuxPC, to: string, subject: string, body: string) {
  const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.3.10', '10.0.3.2', SMTP_PORT);
  smtp.connect();
  smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
  smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
  smtp.sendCommand({ verb: 'RCPT', argument: `TO:<${to}>` });
  smtp.sendCommand({ verb: 'DATA' });
  return smtp.sendDataBody(`Subject: ${subject}\r\n\r\n${body}`);
}

describe('New/Get-TransportRule cmdlets (docs/PRD-Exchange.md §2.1 P6)', () => {
  it('New-TransportRule creates the rule and Get-TransportRule reflects it', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    const out = await run(ps(dc), 'New-TransportRule -Name Blocker -SubjectContainsWords "confidential" -RejectMessageReasonText "Blocked by policy"');
    expect(out).toContain('Blocker');
    expect(out).toContain('Enabled');
    const get = await run(ps(dc), 'Get-TransportRule Blocker');
    expect(get).toContain('Blocker');
    expect(get).toContain('Reject');
  });

  it('Get-TransportRule with no identity lists every rule', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    await run(ps(dc), 'New-TransportRule -Name R1 -SubjectContainsWords "x" -RejectMessageReasonText "no"');
    await run(ps(dc), 'New-TransportRule -Name R2 -SubjectContainsWords "y" -RejectMessageReasonText "no"');
    const out = await run(ps(dc), 'Get-TransportRule');
    expect(out).toContain('R1');
    expect(out).toContain('R2');
  });

  it('creating a second rule with the same name fails cleanly', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    await run(ps(dc), 'New-TransportRule -Name Dup -SubjectContainsWords "x" -RejectMessageReasonText "no"');
    const out = await run(ps(dc), 'New-TransportRule -Name Dup -SubjectContainsWords "y" -RejectMessageReasonText "no"');
    expect(out.toLowerCase()).toContain('already exists');
  });

  it('New-TransportRule and Get-TransportRule fail with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const n = await run(ps(dc), 'New-TransportRule -Name R1 -SubjectContainsWords "x" -RejectMessageReasonText "no"');
    const g = await run(ps(dc), 'Get-TransportRule');
    expect(n).toContain('is not recognized as the name of a cmdlet');
    expect(g).toContain('is not recognized as the name of a cmdlet');
  });
});

describe('Transport Rules really act on live SMTP traffic through a Receive Connector (docs/PRD-Exchange.md §2.1 P6)', () => {
  it('a Reject rule causes a genuine SMTP 550 for a matching message, not a silent post-accept drop', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
    await run(ps(dc), 'New-TransportRule -Name Blocker -SubjectContainsWords "confidential" -RejectMessageReasonText "Blocked by policy"');

    const rejected = sendMail(dc, client, 'bob@mandeng.lan', 'CONFIDENTIAL report', 'secret stuff');
    expect(rejected?.code).toBe(550);
    expect(rejected?.lines.join(' ')).toContain('Blocked by policy');
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(0);

    const accepted = sendMail(dc, client, 'bob@mandeng.lan', 'Lunch plans', 'want to grab lunch?');
    expect(accepted?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
  });

  it('an AppendDisclaimer rule makes the delivered item strictly larger than the same message without it', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'carol');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');

    sendMail(dc, client, 'bob@mandeng.lan', 'hi', 'short body');
    const baselineSize = dc.getMailboxStore()!.get('bob')!.folders.Inbox[0].sizeBytes;

    await run(ps(dc), 'New-TransportRule -Name Disclaimer -ApplyHtmlDisclaimerText "This email is confidential."');
    sendMail(dc, client, 'carol@mandeng.lan', 'hi', 'short body');
    const withDisclaimerSize = dc.getMailboxStore()!.get('carol')!.folders.Inbox[0].sizeBytes;

    expect(withDisclaimerSize).toBeGreaterThan(baselineSize);
  });

  it('a RedirectTo rule overrides delivery to the redirect address instead of the original recipient', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'carol');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
    await run(ps(dc), 'New-TransportRule -Name Redirect -RedirectMessageTo "carol@mandeng.lan"');

    const final = sendMail(dc, client, 'bob@mandeng.lan', 'hi', 'hello');
    expect(final?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(0);
    expect(dc.getMailboxStore()!.get('carol')!.folders.Inbox).toHaveLength(1);
  });

  it('a BlindCopyTo rule delivers to both the original recipient and the BCC address', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'carol');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.3.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
    await run(ps(dc), 'New-TransportRule -Name Audit -BlindCopyTo "carol@mandeng.lan"');

    const final = sendMail(dc, client, 'bob@mandeng.lan', 'hi', 'hello');
    expect(final?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(dc.getMailboxStore()!.get('carol')!.folders.Inbox).toHaveLength(1);
  });
});

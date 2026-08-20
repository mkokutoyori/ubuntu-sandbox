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
  dc.configureInterface('eth0', new IPAddress('10.0.4.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  for (const name of names) {
    await run(ps(dc), `New-Mailbox -Name ${name} -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)`);
  }
  return dc;
}

describe('Add/Get-MailboxPermission (docs/PRD-Exchange.md §2.1 P9) — reuses the AD ACL model, not a second mechanism', () => {
  it('a mailbox owner always implicitly has FullAccess on their own mailbox', async () => {
    const dc = await exchangeServerWithMailboxes('bob');
    expect(dc.userHasMailboxAccess('bob', 'bob', 'FullAccess')).toBe(true);
  });

  it('an unrelated user has no FullAccess until granted', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'alice');
    expect(dc.userHasMailboxAccess('bob', 'alice', 'FullAccess')).toBe(false);
    const out = await run(ps(dc), 'Add-MailboxPermission -Identity bob -User alice -AccessRights FullAccess');
    expect(out).toContain('FullAccess');
    expect(dc.userHasMailboxAccess('bob', 'alice', 'FullAccess')).toBe(true);
  });

  it('Get-MailboxPermission lists the granted trustees', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'alice');
    await run(ps(dc), 'Add-MailboxPermission -Identity bob -User alice -AccessRights FullAccess');
    const out = await run(ps(dc), 'Get-MailboxPermission -Identity bob');
    expect(out).toContain('alice');
    expect(out).toContain('FullAccess');
  });

  it('granting the same permission twice fails cleanly', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'alice');
    await run(ps(dc), 'Add-MailboxPermission -Identity bob -User alice -AccessRights FullAccess');
    const out = await run(ps(dc), 'Add-MailboxPermission -Identity bob -User alice -AccessRights FullAccess');
    expect(out.toLowerCase()).toContain('already exists');
  });

  it('Add-MailboxPermission fails with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Add-MailboxPermission -Identity bob -User alice -AccessRights FullAccess');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

describe('getMailboxContentsAsUser() (docs/PRD-Exchange.md §8 — emblematic P9 test)', () => {
  it('a user without FullAccess cannot inspect a third-party mailbox\'s content; after granting it, they can', async () => {
    const dc = await exchangeServerWithMailboxes('bob', 'alice');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.4.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');

    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.4.10', '10.0.4.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<external@partner.example>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    smtp.sendDataBody('Subject: secret\r\n\r\nConfidential.');

    expect(dc.getMailboxContentsAsUser('bob', 'alice')).toBeNull();

    await run(ps(dc), 'Add-MailboxPermission -Identity bob -User alice -AccessRights FullAccess');
    const contents = dc.getMailboxContentsAsUser('bob', 'alice');
    expect(contents).not.toBeNull();
    expect(contents).toHaveLength(1);
    expect(contents![0].subject).toBe('secret');
  });
});

describe('Add/Get-RecipientPermission -AccessRights SendAs — real SMTP-level enforcement (docs/PRD-Exchange.md §8, emblematic P9 test)', () => {
  async function labWithAuthConnector() {
    const dc = await exchangeServerWithMailboxes('bob', 'alice');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.4.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25" -AuthMechanism BasicAuth');
    return { dc, client };
  }

  it('an authenticated user without SendAs cannot impersonate another mailbox\'s From address — real SMTP 550', async () => {
    const { dc, client } = await labWithAuthConnector();
    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.4.10', '10.0.4.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    const authReply = smtp.authPlain('alice', 'P@ssw0rd1!');
    expect(authReply?.code).toBe(235);

    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nfaking bob');

    expect(final?.code).toBe(550);
    expect(final?.lines.join(' ')).toContain('permissions to send as this sender');
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(0);
  });

  it('after Add-RecipientPermission -AccessRights SendAs, the same impersonation succeeds for real', async () => {
    const { dc, client } = await labWithAuthConnector();
    const grant = await run(ps(dc), 'Add-RecipientPermission -Identity bob -Trustee alice -AccessRights SendAs');
    expect(grant).toContain('SendAs');

    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.4.10', '10.0.4.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.authPlain('alice', 'P@ssw0rd1!');
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nreal SendAs delivery');

    expect(final?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
  });

  it('a user sending as themselves is never blocked, with or without an AUTH session', async () => {
    const { dc, client } = await labWithAuthConnector();
    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.4.10', '10.0.4.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.authPlain('alice', 'P@ssw0rd1!');
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nfrom myself');

    expect(final?.code).toBe(250);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
  });

  it('Get-RecipientPermission lists the granted trustees', async () => {
    const { dc } = await labWithAuthConnector();
    await run(ps(dc), 'Add-RecipientPermission -Identity bob -Trustee alice -AccessRights SendAs');
    const out = await run(ps(dc), 'Get-RecipientPermission -Identity bob');
    expect(out).toContain('alice');
    expect(out).toContain('SendAs');
  });
});

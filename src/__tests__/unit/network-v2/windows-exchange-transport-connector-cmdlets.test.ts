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

async function exchangeServerWithMailbox(name: string): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.configureInterface('eth0', new IPAddress('10.0.2.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  await run(ps(dc), `New-Mailbox -Name ${name} -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)`);
  return dc;
}

describe('New/Get-ReceiveConnector — a connector really is an SMTP binding (docs/PRD-Exchange.md §2.1 P5)', () => {
  it('New-ReceiveConnector starts a real listening SmtpServer; a live SMTP transaction lands in the mailbox Inbox', async () => {
    const dc = await exchangeServerWithMailbox('bob');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);

    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');

    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.2.10', '10.0.2.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nHello Bob.');

    expect(final?.code).toBe(250);
    const stats = dc.getMailboxStore()!.get('bob')!;
    expect(stats.folders.Inbox).toHaveLength(1);
    expect(stats.folders.Inbox[0].subject).toBe('hi');
  });

  it('a Receive Connector with a remote IP restriction really rejects an out-of-range connection at the TCP/SMTP level', async () => {
    const dc = await exchangeServerWithMailbox('bob');
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('10.0.2.2'), new SubnetMask('255.255.255.0'));
    new Cable('c1').connect(client.getPort('eth0')!, dc.getPort('eth0')!);

    await run(ps(dc), 'New-ReceiveConnector -Name Restricted -Bindings "0.0.0.0:25" -RemoteIPRanges "203.0.113.0/24"');

    const smtp = new SmtpClientSession(client.getTcpStack(), '10.0.2.10', '10.0.2.2', SMTP_PORT);
    const banner = smtp.connect();
    expect(banner).toBeNull();
  });

  it('Get-ReceiveConnector reflects the created connector', async () => {
    const dc = await exchangeServerWithMailbox('bob');
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
    const out = await run(ps(dc), 'Get-ReceiveConnector MainReceive');
    expect(out).toContain('MainReceive');
    expect(out).toContain('0.0.0.0:25');
  });

  it('creating a second connector with the same name fails cleanly', async () => {
    const dc = await exchangeServerWithMailbox('bob');
    await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:26"');
    const out = await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:27"');
    expect(out.toLowerCase()).toContain('already exists');
  });
});

describe('New/Get-SendConnector (docs/PRD-Exchange.md §2.1 P5)', () => {
  it('creates a named outbound policy with address spaces, smart hosts, and cost', async () => {
    const dc = await exchangeServerWithMailbox('bob');
    const out = await run(ps(dc), 'New-SendConnector -Name Partner -AddressSpaces "partner.example" -SmartHosts "10.0.0.5" -Cost 5');
    expect(out).toContain('Partner');
    expect(out).toContain('partner.example');
    expect(out).toContain('10.0.0.5');
  });

  it('Get-SendConnector with no identity lists every configured connector', async () => {
    const dc = await exchangeServerWithMailbox('bob');
    await run(ps(dc), 'New-SendConnector -Name Partner -AddressSpaces "partner.example"');
    await run(ps(dc), 'New-SendConnector -Name Wildcard -AddressSpaces "*"');
    const out = await run(ps(dc), 'Get-SendConnector');
    expect(out).toContain('Partner');
    expect(out).toContain('Wildcard');
  });
});

describe('Transport connector cmdlets fail with "not recognized" before Install-ExchangeServer', () => {
  it('New-ReceiveConnector and New-SendConnector both gate the same way', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const recv = await run(ps(dc), 'Get-ReceiveConnector');
    const send = await run(ps(dc), 'Get-SendConnector');
    expect(recv).toContain('is not recognized as the name of a cmdlet');
    expect(send).toContain('is not recognized as the name of a cmdlet');
  });
});

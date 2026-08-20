import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxPC } from '@/network/devices/LinuxPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { resetExchangeOrganizations } from '@/network/devices/windows/server/exchange/ExchangeOrganization';
import { SmtpClientSession } from '@/network/smtp/SmtpClientSession';
import { SmtpServer, SMTP_PORT, type SmtpAcceptedMessage } from '@/network/smtp/SmtpServer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetExchangeOrganizations();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLab() {
  const dc = new WindowsServer('DC01');
  const dns = new WindowsServer('DNS1');
  const partner = new LinuxPC('linux-pc', 'PARTNER1');
  const client = new LinuxPC('linux-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const mask = new SubnetMask('255.255.255.0');

  new Cable('c1').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c2').connect(dns.getPorts()[0], sw.getPorts()[1]);
  new Cable('c3').connect(partner.getPorts()[0], sw.getPorts()[2]);
  new Cable('c4').connect(client.getPorts()[0], sw.getPorts()[3]);

  dc.getPorts()[0].configureIP(new IPAddress('192.168.80.10'), mask);
  dns.getPorts()[0].configureIP(new IPAddress('192.168.80.5'), mask);
  partner.getPorts()[0].configureIP(new IPAddress('192.168.80.30'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.80.2'), mask);

  dc.setCurrentUser('Administrator');
  dns.setCurrentUser('Administrator');

  await run(ps(dns), 'Install-WindowsFeature DNS');
  await run(ps(dns), 'Add-DnsServerPrimaryZone -Name partner.example');
  await run(ps(dns), 'Add-DnsServerResourceRecordA -ZoneName partner.example -Name mail -IPv4Address 192.168.80.30');
  await run(ps(dns), 'Add-DnsServerResourceRecordMX -ZoneName partner.example -Name "@" -MailExchange mail.partner.example -Preference 10');

  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Set-DnsClientServerAddress -InterfaceAlias eth0 -ServerAddresses "192.168.80.5"');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  await run(ps(dc), 'New-Mailbox -Name bob -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');
  await run(ps(dc), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');
  await run(ps(dc), 'New-SendConnector -Name Internet -AddressSpaces "*"');

  const accepted: SmtpAcceptedMessage[] = [];
  const partnerServer = new SmtpServer(partner.getTcpStack(), { hostname: 'mail.partner.example' }, SMTP_PORT, {
    onMessageAccepted: (d) => accepted.push(d),
  });
  partnerServer.start();

  return { dc, client, accepted };
}

function sendToBobWithBcc(dc: WindowsServer, client: LinuxPC) {
  const smtp = new SmtpClientSession(client.getTcpStack(), '192.168.80.10', '192.168.80.2', SMTP_PORT);
  smtp.connect();
  smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
  smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
  smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
  smtp.sendCommand({ verb: 'DATA' });
  return smtp.sendDataBody('Subject: hi\r\n\r\nHello Bob.');
}

describe('Get-Queue/Retry-Queue/Suspend-Queue/Resume-Queue (docs/PRD-Exchange.md §2.1 P7)', () => {
  it('a BlindCopyTo Transport Rule targeting an external domain queues for relay instead of silently dropping it', async () => {
    const { dc, client, accepted } = await buildLab();
    await run(ps(dc), 'New-TransportRule -Name Audit -BlindCopyTo "archive@partner.example"');

    const final = sendToBobWithBcc(dc, client);
    expect(final?.code).toBe(250);

    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(accepted).toHaveLength(0);

    const out = await run(ps(dc), 'Get-Queue');
    expect(out).toContain('partner.example');
    expect(out).toContain('1');
  });

  it('Retry-Queue really relays the queued message over real DNS-resolved MX to the external server', async () => {
    const { dc, client, accepted } = await buildLab();
    await run(ps(dc), 'New-TransportRule -Name Audit -BlindCopyTo "archive@partner.example"');
    sendToBobWithBcc(dc, client);

    await run(ps(dc), 'Retry-Queue -Identity partner.example');
    await dc.getDeliveryQueue()!.tick();

    expect(accepted).toHaveLength(1);
    expect(accepted[0].envelope.from).toBe('alice@mandeng.lan');
    expect(accepted[0].envelope.to).toEqual(['archive@partner.example']);

    const after = await run(ps(dc), 'Get-Queue');
    expect(after).not.toContain('partner.example');
  });

  it('Suspend-Queue prevents delivery even when Retry-Queue is called; Resume-Queue lets it through', async () => {
    const { dc, client, accepted } = await buildLab();
    await run(ps(dc), 'New-TransportRule -Name Audit -BlindCopyTo "archive@partner.example"');
    sendToBobWithBcc(dc, client);

    await run(ps(dc), 'Suspend-Queue -Identity partner.example');
    await run(ps(dc), 'Retry-Queue -Identity partner.example');
    await dc.getDeliveryQueue()!.tick();
    expect(accepted).toHaveLength(0);

    const suspended = await run(ps(dc), 'Get-Queue');
    expect(suspended).toContain('Suspended');

    await run(ps(dc), 'Resume-Queue -Identity partner.example');
    await run(ps(dc), 'Retry-Queue -Identity partner.example');
    await dc.getDeliveryQueue()!.tick();
    expect(accepted).toHaveLength(1);
  });

  it('Get-Queue/Retry-Queue/Suspend-Queue/Resume-Queue fail with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const get = await run(ps(dc), 'Get-Queue');
    const retry = await run(ps(dc), 'Retry-Queue -Identity partner.example');
    const suspend = await run(ps(dc), 'Suspend-Queue -Identity partner.example');
    const resume = await run(ps(dc), 'Resume-Queue -Identity partner.example');
    expect(get).toContain('is not recognized as the name of a cmdlet');
    expect(retry).toContain('is not recognized as the name of a cmdlet');
    expect(suspend).toContain('is not recognized as the name of a cmdlet');
    expect(resume).toContain('is not recognized as the name of a cmdlet');
  });
});

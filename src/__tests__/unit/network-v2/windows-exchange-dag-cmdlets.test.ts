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
import { SMTP_PORT } from '@/network/smtp/SmtpServer';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  resetExchangeOrganizations();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function promoteDc(dc: WindowsServer): Promise<void> {
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
}

async function twoServerOrg(): Promise<{ dc1: WindowsServer; dc2: WindowsServer; sw: GenericSwitch }> {
  const dc1 = new WindowsServer('DC01');
  const dc2 = new WindowsServer('DC02');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc1').connect(dc1.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dc2').connect(dc2.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc1.getPorts()[0].configureIP(new IPAddress('192.168.11.10'), mask);
  dc2.getPorts()[0].configureIP(new IPAddress('192.168.11.11'), mask);

  await promoteDc(dc1);
  dc2.setCurrentUser('Administrator');
  await run(ps(dc2), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc2), 'Install-ADDSDomainController -DomainName "mandeng.lan" -Credential "Administrator:DSRM@Mandeng2025!" -Server "192.168.11.10" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');

  await run(ps(dc1), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  await run(ps(dc2), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  await run(ps(dc1), 'New-Mailbox -Name bob -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)');

  return { dc1, dc2, sw };
}

describe('New/Add-DatabaseAvailabilityGroup* (docs/PRD-Exchange.md §2.1 P11)', () => {
  it('New-DatabaseAvailabilityGroup then Add-DatabaseAvailabilityGroupServer registers both members', async () => {
    const { dc1 } = await twoServerOrg();
    const created = await run(ps(dc1), 'New-DatabaseAvailabilityGroup -Name DAG1');
    expect(created).toContain('DAG1');
    await run(ps(dc1), 'Add-DatabaseAvailabilityGroupServer -Identity DAG1 -MailboxServer DC01');
    const res = await run(ps(dc1), 'Add-DatabaseAvailabilityGroupServer -Identity DAG1 -MailboxServer DC02');
    expect(res).not.toContain('is not recognized');
    expect(dc1.getDatabaseAvailabilityGroup('DAG1')!.members.has('DC01')).toBe(true);
    expect(dc1.getDatabaseAvailabilityGroup('DAG1')!.members.has('DC02')).toBe(true);
  });

  it('adding a second DAG member with no database copy does not affect any existing mailbox', async () => {
    const { dc1 } = await twoServerOrg();
    await run(ps(dc1), 'New-DatabaseAvailabilityGroup -Name DAG1');
    await run(ps(dc1), 'Add-DatabaseAvailabilityGroupServer -Identity DAG1 -MailboxServer DC01');
    await run(ps(dc1), 'Add-DatabaseAvailabilityGroupServer -Identity DAG1 -MailboxServer DC02');
    expect(dc1.getMailboxStore()!.get('bob')).not.toBeNull();
    expect(dc1.getMailboxDatabaseCopyStatus('DAG1')).toEqual([]);
  });

  it('New-DatabaseAvailabilityGroup fails with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'New-DatabaseAvailabilityGroup -Name DAG1');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

describe('Replication lag between two Exchange servers in the same DAG (docs/PRD-Exchange.md §8, emblematic P11 test)', () => {
  it('a mailbox change on the org shows up as copy lag on the passive server; Update-MailboxDatabaseCopy clears it', async () => {
    const { dc1, dc2, sw } = await twoServerOrg();
    const client = new LinuxPC('linux-pc', 'CLIENT1');
    client.configureInterface('eth0', new IPAddress('192.168.11.2'), new SubnetMask('255.255.255.0'));
    new Cable('c-client').connect(client.getPort('eth0')!, sw.getPorts()[2]);
    await run(ps(dc1), 'New-ReceiveConnector -Name MainReceive -Bindings "0.0.0.0:25"');

    await run(ps(dc1), 'New-DatabaseAvailabilityGroup -Name DAG1');
    await run(ps(dc1), 'Add-DatabaseAvailabilityGroupServer -Identity DAG1 -MailboxServer DC01');
    await run(ps(dc1), 'Add-DatabaseAvailabilityGroupServer -Identity DAG1 -MailboxServer DC02');
    await run(ps(dc1), 'Add-MailboxDatabaseCopy -DatabaseAvailabilityGroup DAG1 -Database "Mailbox Database 1" -MailboxServer DC02');

    const before = await run(ps(dc2), 'Get-MailboxDatabaseCopyStatus -DatabaseAvailabilityGroup DAG1 -Database "Mailbox Database 1"');
    expect(before).toContain('Healthy');
    expect(before).toContain('0');

    const smtp = new SmtpClientSession(client.getTcpStack(), '192.168.11.10', '192.168.11.2', SMTP_PORT);
    smtp.connect();
    smtp.sendCommand({ verb: 'EHLO', argument: 'client.mandeng.lan' });
    smtp.sendCommand({ verb: 'MAIL', argument: 'FROM:<alice@mandeng.lan>' });
    smtp.sendCommand({ verb: 'RCPT', argument: 'TO:<bob@mandeng.lan>' });
    smtp.sendCommand({ verb: 'DATA' });
    const final = smtp.sendDataBody('Subject: hi\r\n\r\nHello Bob.');
    expect(final?.code).toBe(250);

    const afterDelivery = dc2.getMailboxDatabaseCopyStatus('DAG1', 'Mailbox Database 1')[0];
    expect(afterDelivery.copyQueueLength).toBeGreaterThan(0);
    expect(afterDelivery.status).toBe('Resynchronizing');

    await run(ps(dc2), 'Update-MailboxDatabaseCopy -DatabaseAvailabilityGroup DAG1 -Database "Mailbox Database 1" -MailboxServer DC02');
    const afterSync = dc2.getMailboxDatabaseCopyStatus('DAG1', 'Mailbox Database 1')[0];
    expect(afterSync.copyQueueLength).toBe(0);
    expect(afterSync.status).toBe('Healthy');
  });
});

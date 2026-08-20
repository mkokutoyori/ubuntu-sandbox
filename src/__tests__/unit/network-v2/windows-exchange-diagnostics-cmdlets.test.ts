import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
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

async function exchangeServerWithMailboxes(...names: string[]): Promise<WindowsServer> {
  const dc = new WindowsServer('DC01');
  dc.configureInterface('eth0', new IPAddress('10.0.6.10'), new SubnetMask('255.255.255.0'));
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
  await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
  await run(ps(dc), 'Install-ExchangeServer -Roles Mailbox -OrganizationName "Mandeng"');
  for (const name of names) {
    await run(ps(dc), `New-Mailbox -Name ${name} -Password (ConvertTo-SecureString "P@ssw0rd1!" -AsPlainText -Force)`);
  }
  return dc;
}

describe('Test-ServiceHealth (docs/PRD-Exchange.md §2.1 P12) — reuses WindowsServiceManager, not a second registry', () => {
  it('every Mailbox-role service is Running and expected right after install', async () => {
    const dc = await exchangeServerWithMailboxes();
    const out = await run(ps(dc), 'Test-ServiceHealth');
    expect(out).toContain('MSExchangeTransport');
    expect(out).toContain('Running');
  });

  it('distinguishes a service outside this server\'s installed roles (expected:false) from a genuinely down expected service', async () => {
    const dc = await exchangeServerWithMailboxes();
    const results = dc.testServiceHealth();
    const transport = results.find((r) => r.serviceName === 'MSExchangeTransport')!;
    const frontEnd = results.find((r) => r.serviceName === 'MSExchangeFrontEndTransport')!;
    expect(transport.expected).toBe(true);
    expect(transport.status).toBe('Running');
    expect(frontEnd.expected).toBe(false);
    expect(frontEnd.status).toBe('Stopped');
  });

  it('a stopped expected service is reported Stopped + expected:true', async () => {
    const dc = await exchangeServerWithMailboxes();
    await run(ps(dc), 'Stop-Service -Name MSExchangeTransport');
    const results = dc.testServiceHealth();
    const transport = results.find((r) => r.serviceName === 'MSExchangeTransport')!;
    expect(transport.status).toBe('Stopped');
    expect(transport.expected).toBe(true);
  });

  it('fails with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Test-ServiceHealth');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

describe('Test-Mailflow (docs/PRD-Exchange.md §2.1 P12, §8 emblematic test) — a real delivery, never a success façade', () => {
  it('succeeds in normal conditions and really delivers the test message', async () => {
    const dc = await exchangeServerWithMailboxes('alice', 'bob');
    const out = await run(ps(dc), 'Test-Mailflow -Identity alice -TargetMailboxIdentity bob');
    expect(out).toContain('Success');
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(1);
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox[0].subject).toBe('Test-Mailflow');
  });

  it('fails explicitly when the target mailbox is disabled — no false success', async () => {
    const dc = await exchangeServerWithMailboxes('alice', 'bob');
    await run(ps(dc), 'Disable-Mailbox -Identity bob');
    const out = await run(ps(dc), 'Test-Mailflow -Identity alice -TargetMailboxIdentity bob');
    expect(out).toContain('Failure');
    expect(out.toLowerCase()).toContain('could not be found');
  });

  it('fails explicitly when the target mailbox quota is exceeded — no false success', async () => {
    const dc = await exchangeServerWithMailboxes('alice', 'bob');
    await run(ps(dc), 'Set-Mailbox -Identity bob -ProhibitSendReceiveQuota 1');
    const out = await run(ps(dc), 'Test-Mailflow -Identity alice -TargetMailboxIdentity bob');
    expect(out).toContain('Failure');
    expect(out.toLowerCase()).toContain('quota');
    expect(dc.getMailboxStore()!.get('bob')!.folders.Inbox).toHaveLength(0);
  });

  it('fails with "not recognized" before Install-ExchangeServer', async () => {
    const dc = new WindowsServer('DC01');
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature -Name AD-Domain-Services -IncludeManagementTools');
    await run(ps(dc), 'Install-ADDSForest -DomainName "mandeng.lan" -DomainNetBiosName "MANDENG" -SafeModeAdministratorPassword (ConvertTo-SecureString "DSRM@Mandeng2025!" -AsPlainText -Force) -Force:$true');
    const out = await run(ps(dc), 'Test-Mailflow -Identity alice -TargetMailboxIdentity bob');
    expect(out).toContain('is not recognized as the name of a cmdlet');
  });
});

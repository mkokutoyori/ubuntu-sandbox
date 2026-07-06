/**
 * PRD-Windows-Server-Advanced.md §5 P24 — domain join/logon now
 * authenticate over real Kerberos (AS exchange → TGS exchange for the
 * DC's own computer account → GSSAPI SASL bind) instead of a plaintext
 * LDAP simple bind. `windows-server-domain-join.test.ts` (unmodified,
 * still green) proves the observable behaviour didn't change; this file
 * proves the *mechanism* actually changed by asserting the DC's own
 * `KerberosSignalStore` — fed exclusively by `KdcSessionHandler`'s real
 * TCP/88 traffic (§5 P12) — records a genuine AS+TGS exchange during both
 * `Add-Computer` and a domain logon.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { WindowsPC } from '@/network/devices/WindowsPC';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { EventBus, __setDefaultEventBus } from '@/events/EventBus';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
  __setDefaultEventBus(new EventBus());
});

const ps = (d: WindowsServer | WindowsPC) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; member: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC1');
  const member = new WindowsServer('SRV1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-member').connect(member.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);

  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.41.10'), mask);
  member.getPorts()[0].configureIP(new IPAddress('192.168.41.20'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.41.30'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

  member.setCurrentUser('Administrator');
  client.setCurrentUser('Administrator');
  return { dc, member, client };
}

describe('Domain join/logon over real Kerberos (§5 P24)', () => {
  it('Add-Computer performs a genuine AS+TGS exchange against the DC (not a plaintext bind)', async () => {
    const { dc, member } = await buildLan();
    const before = dc.getKerberosSignals().stats.get();

    const out = await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.41.10');
    expect(out).toBe('');
    expect(member.getDomainMembership()?.dnsName).toBe('lab.local');

    const after = dc.getKerberosSignals().stats.get();
    expect(after.asSucceeded).toBeGreaterThan(before.asSucceeded);
    expect(after.tgsSucceeded).toBeGreaterThan(before.tgsSucceeded);
    expect(dc.getKerberosSignals().log.get().some(e => e.kind === 'as-succeeded' && e.cname === 'Administrator')).toBe(true);
  });

  it('a bad join password surfaces as a real KDC AS-exchange failure, not a fabricated message', async () => {
    const { dc, member } = await buildLan();
    const before = dc.getKerberosSignals().stats.get();

    const out = await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:wrongpassword" -Server 192.168.41.10');
    expect(out).toMatch(/Logon failure/i);

    const after = dc.getKerberosSignals().stats.get();
    expect(after.asFailed).toBeGreaterThan(before.asFailed);
  });

  it('a domain logon performs a genuine AS+TGS exchange for the logging-on user', async () => {
    const { dc, member, client } = await buildLan();
    await run(ps(member), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.41.10');
    await member.executeCmdCommand('winrm quickconfig');
    client.addHostsEntry('192.168.41.20', 'SRV1');

    const before = dc.getKerberosSignals().stats.get();
    const out = await run(ps(client), 'Invoke-Command -ComputerName SRV1 -Credential LAB\\alice:alicepw -ScriptBlock { $env:COMPUTERNAME }');
    expect(out.trim()).toBe('SRV1');

    const after = dc.getKerberosSignals().stats.get();
    expect(after.asSucceeded).toBeGreaterThan(before.asSucceeded);
    expect(after.tgsSucceeded).toBeGreaterThan(before.tgsSucceeded);
    expect(dc.getKerberosSignals().log.get().some(e => e.kind === 'as-succeeded' && e.cname === 'alice')).toBe(true);
  });
});

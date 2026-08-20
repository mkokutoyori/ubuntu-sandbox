/**
 * PRD-Windows-Server-Advanced.md §5 P9 — trusts + cross-realm Kerberos
 * referrals: `New-ADTrust` establishes a simple trust between two
 * independent domains (real LDAP dial+bind, then a real LDAP `AddRequest`
 * pushes the mirrored, direction-flipped trust record to the remote
 * domain's own directory); `crossRealmTgsExchange` then lets a user
 * authenticated in realm A obtain a service ticket in realm B via an
 * RFC 4120 §3.3.3 inter-realm referral TGT — and fails cleanly with no
 * trust configured.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, IPAddress, SubnetMask } from '@/network/core/types';
import { WindowsServer } from '@/network/devices/WindowsServer';
import { LinuxServer } from '@/network/devices/LinuxServer';
import { GenericSwitch } from '@/network/devices/GenericSwitch';
import { Cable } from '@/network/hardware/Cable';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { PowerShellSubShell } from '@/terminal/subshells/PowerShellSubShell';
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { crossRealmTgsExchange } from '@/network/kerberos/crossRealm';
import { KrbErrorCode } from '@/network/kerberos/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildTwoDomains(): Promise<{ dcA: WindowsServer; dcB: WindowsServer; client: LinuxServer }> {
  const dcA = new WindowsServer('DC-A');
  const dcB = new WindowsServer('DC-B');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dca').connect(dcA.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-dcb').connect(dcB.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[2]);
  const mask = new SubnetMask('255.255.255.0');
  dcA.getPorts()[0].configureIP(new IPAddress('192.168.95.10'), mask);
  dcB.getPorts()[0].configureIP(new IPAddress('192.168.95.11'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.95.20'), mask);

  dcA.setCurrentUser('Administrator');
  await run(ps(dcA), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dcA), 'Install-ADDSForest -DomainName a.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dcA), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

  dcB.setCurrentUser('Administrator');
  await run(ps(dcB), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dcB), 'Install-ADDSForest -DomainName b.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

  return { dcA, dcB, client };
}

const newTrustCmd =
  'New-ADTrust -Target b.local -Direction Bidirectional -Credential "Administrator:P@ssw0rd" -Server 192.168.95.11';

describe('New-ADTrust — establishing a simple trust between two domains', () => {
  it('records the trust locally and pushes the mirrored record to the remote domain', async () => {
    const { dcA, dcB } = await buildTwoDomains();
    const out = await run(ps(dcA), newTrustCmd);
    expect(out).not.toMatch(/ERROR/);

    const localTrust = await run(ps(dcA), 'Get-ADTrust -Identity b.local');
    expect(localTrust).toContain('b.local');
    expect(localTrust).toContain('Bidirectional');

    const remoteTrust = await run(ps(dcB), 'Get-ADTrust -Identity a.local');
    expect(remoteTrust).toMatch(/a\.local/i);
    expect(remoteTrust).toContain('Bidirectional');
  });

  it('fails cleanly with bad credentials and records no trust', async () => {
    const { dcA } = await buildTwoDomains();
    const out = await run(
      ps(dcA),
      'New-ADTrust -Target b.local -Direction Bidirectional -Credential "Administrator:wrongpassword" -Server 192.168.95.11',
    );
    expect(out).toMatch(/Logon failure/);
    const trust = await run(ps(dcA), 'Get-ADTrust -Identity b.local');
    expect(trust).toMatch(/ERROR|Cannot find/);
  });

  it('fails cleanly when the remote DC is unreachable', async () => {
    const { dcA } = await buildTwoDomains();
    const out = await run(
      ps(dcA),
      'New-ADTrust -Target b.local -Direction Bidirectional -Credential "Administrator:P@ssw0rd" -Server 192.168.95.99',
    );
    expect(out).toMatch(/could not be contacted/);
  });
});

describe('Cross-realm Kerberos referral (RFC 4120 §3.3.3) — user of domain A reaching a resource in domain B', () => {
  it('obtains a real service ticket in B via an inter-realm referral TGT once a trust exists', async () => {
    const { dcA, dcB, client } = await buildTwoDomains();
    await run(ps(dcA), newTrustCmd);

    const conn = dialKdc(client.getTcpStack(), '192.168.95.10');
    expect(conn.ok).toBe(true);
    const asResult = conn.client!.asExchange('alice', 'alicepw', 'A.LOCAL');
    expect(asResult.ok).toBe(true);

    const result = crossRealmTgsExchange(
      client.getTcpStack(), '192.168.95.10', '192.168.95.11',
      asResult.ticket!, asResult.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'A.LOCAL',
      'B.LOCAL', dcB.getHostname(),
    );
    expect(result.ok).toBe(true);
    expect(result.ticket?.sname.nameString).toEqual([dcB.getHostname()]);
    expect(result.ticket?.realm).toBe('B.LOCAL');
    expect(result.encKdcRepPart?.srealm).toBe('B.LOCAL');
  });

  it('fails cleanly with no repli silencieux when no trust is configured', async () => {
    const { dcB, client } = await buildTwoDomains();
    const conn = dialKdc(client.getTcpStack(), '192.168.95.10');
    const asResult = conn.client!.asExchange('alice', 'alicepw', 'A.LOCAL');
    expect(asResult.ok).toBe(true);

    const result = crossRealmTgsExchange(
      client.getTcpStack(), '192.168.95.10', '192.168.95.11',
      asResult.ticket!, asResult.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'A.LOCAL',
      'B.LOCAL', dcB.getHostname(),
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KDC_ERR_POLICY);
  });

  it('a one-way Outbound trust from A lets A reach B but not the reverse', async () => {
    const { dcA, dcB, client } = await buildTwoDomains();
    await run(ps(dcA), 'New-ADTrust -Target b.local -Direction Outbound -Credential "Administrator:P@ssw0rd" -Server 192.168.95.11');

    await run(ps(dcB), 'New-ADUser -Name bob -AccountPassword (ConvertTo-SecureString "bobpw" -AsPlainText -Force) -DisplayName "Bob"');

    const connA = dialKdc(client.getTcpStack(), '192.168.95.10');
    const asA = connA.client!.asExchange('alice', 'alicepw', 'A.LOCAL');
    const aToB = crossRealmTgsExchange(
      client.getTcpStack(), '192.168.95.10', '192.168.95.11',
      asA.ticket!, asA.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'A.LOCAL',
      'B.LOCAL', dcB.getHostname(),
    );
    expect(aToB.ok).toBe(true);

    const connB = dialKdc(client.getTcpStack(), '192.168.95.11');
    const asB = connB.client!.asExchange('bob', 'bobpw', 'B.LOCAL');
    const bToA = crossRealmTgsExchange(
      client.getTcpStack(), '192.168.95.11', '192.168.95.10',
      asB.ticket!, asB.sessionKey!, { nameType: 1, nameString: ['bob'] }, 'B.LOCAL',
      'A.LOCAL', dcA.getHostname(),
    );
    expect(bToA.ok).toBe(false);
    expect(bToA.errorCode).toBe(KrbErrorCode.KDC_ERR_POLICY);
  });
});

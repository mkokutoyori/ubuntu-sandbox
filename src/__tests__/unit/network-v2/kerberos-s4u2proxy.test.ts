/**
 * PRD-Windows-Server-Advanced.md §5 P10 — constrained Kerberos delegation
 * (MS-SFU's S4U2Proxy): a service already holding its own TGT and an
 * "evidence ticket" (the service ticket a user presented to it) can
 * obtain a ticket to a second service on that user's behalf, but only if
 * `msDS-AllowedToDelegateTo` (`Set-ADComputer -AllowedToDelegateTo`) lists
 * the target — the double-hop WinRM/SMB scenario.
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
import { dialKdc } from '@/network/kerberos/KerberosClient';
import { principalName, PrincipalNameType, KrbErrorCode } from '@/network/kerberos/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLab(): Promise<{ dc: WindowsServer; middleSrv: WindowsServer; backendSrv: WindowsServer; client: WindowsPC }> {
  const dc = new WindowsServer('DC1');
  const middleSrv = new WindowsServer('MIDDLE1');
  const backendSrv = new WindowsServer('BACKEND1');
  const client = new WindowsPC('windows-pc', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-mid').connect(middleSrv.getPorts()[0], sw.getPorts()[1]);
  new Cable('c-back').connect(backendSrv.getPorts()[0], sw.getPorts()[2]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[3]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.99.10'), mask);
  middleSrv.getPorts()[0].configureIP(new IPAddress('192.168.99.11'), mask);
  backendSrv.getPorts()[0].configureIP(new IPAddress('192.168.99.12'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.99.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

  middleSrv.setCurrentUser('Administrator');
  await run(ps(middleSrv), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.99.10');
  backendSrv.setCurrentUser('Administrator');
  await run(ps(backendSrv), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.99.10');

  return { dc, middleSrv, backendSrv, client };
}

describe('S4U2Proxy — constrained Kerberos delegation (RFC 4120 §5.4.1 additional-tickets, MS-SFU)', () => {
  it('lets an authorized delegating service obtain a ticket for the user on the backend service', async () => {
    const { dc, client } = await buildLab();
    await run(ps(dc), 'Set-ADComputer -Identity MIDDLE1 -AllowedToDelegateTo BACKEND1');

    const clientConn = dialKdc(client.getTcpStack(), '192.168.99.10');
    const asAlice = clientConn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(asAlice.ok).toBe(true);

    // Alice requests a service ticket for MIDDLE1 and (conceptually) presents it there.
    const aliceToMiddle = clientConn.client!.tgsExchange(
      asAlice.ticket!, asAlice.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'MIDDLE1',
    );
    expect(aliceToMiddle.ok).toBe(true);
    const evidenceTicket = aliceToMiddle.ticket!;

    // MIDDLE1 obtains its own TGT (its computer-account secret) to talk to the KDC as itself.
    const midConn = dialKdc(client.getTcpStack(), '192.168.99.10');
    const midSecret = dc.getDirectoryStore()!.getComputerSecret('MIDDLE1')!;
    const asMiddle = midConn.client!.asExchange('MIDDLE1$', midSecret, 'LAB.LOCAL');
    expect(asMiddle.ok).toBe(true);

    const s4u = midConn.client!.s4u2Proxy(
      asMiddle.ticket!, asMiddle.sessionKey!, principalName(PrincipalNameType.NT_PRINCIPAL, 'MIDDLE1$'), 'LAB.LOCAL',
      evidenceTicket, 'BACKEND1',
    );
    expect(s4u.ok).toBe(true);
    expect(s4u.ticket?.sname.nameString).toEqual(['BACKEND1']);
    // The delegated ticket carries the *user's* identity, not MIDDLE1's.
    expect(s4u.encKdcRepPart?.sname.nameString).toEqual(['BACKEND1']);
    expect(s4u.ok && s4u.ticket).toBeTruthy();
  });

  it('rejects delegation to a service not listed in msDS-AllowedToDelegateTo', async () => {
    const { dc, client } = await buildLab();
    await run(ps(dc), 'Set-ADComputer -Identity MIDDLE1 -AllowedToDelegateTo SOMEOTHERSERVICE');

    const clientConn = dialKdc(client.getTcpStack(), '192.168.99.10');
    const asAlice = clientConn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    const aliceToMiddle = clientConn.client!.tgsExchange(
      asAlice.ticket!, asAlice.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'MIDDLE1',
    );
    const evidenceTicket = aliceToMiddle.ticket!;

    const midConn = dialKdc(client.getTcpStack(), '192.168.99.10');
    const midSecret = dc.getDirectoryStore()!.getComputerSecret('MIDDLE1')!;
    const asMiddle = midConn.client!.asExchange('MIDDLE1$', midSecret, 'LAB.LOCAL');

    const s4u = midConn.client!.s4u2Proxy(
      asMiddle.ticket!, asMiddle.sessionKey!, principalName(PrincipalNameType.NT_PRINCIPAL, 'MIDDLE1$'), 'LAB.LOCAL',
      evidenceTicket, 'BACKEND1',
    );
    expect(s4u.ok).toBe(false);
    expect(s4u.errorCode).toBe(KrbErrorCode.KDC_ERR_BADOPTION);
  });

  it('rejects delegation when no msDS-AllowedToDelegateTo has been configured at all', async () => {
    const { dc, client } = await buildLab();

    const clientConn = dialKdc(client.getTcpStack(), '192.168.99.10');
    const asAlice = clientConn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    const aliceToMiddle = clientConn.client!.tgsExchange(
      asAlice.ticket!, asAlice.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'MIDDLE1',
    );
    const evidenceTicket = aliceToMiddle.ticket!;

    const midConn = dialKdc(client.getTcpStack(), '192.168.99.10');
    const midSecret = dc.getDirectoryStore()!.getComputerSecret('MIDDLE1')!;
    const asMiddle = midConn.client!.asExchange('MIDDLE1$', midSecret, 'LAB.LOCAL');

    const s4u = midConn.client!.s4u2Proxy(
      asMiddle.ticket!, asMiddle.sessionKey!, principalName(PrincipalNameType.NT_PRINCIPAL, 'MIDDLE1$'), 'LAB.LOCAL',
      evidenceTicket, 'BACKEND1',
    );
    expect(s4u.ok).toBe(false);
    expect(s4u.errorCode).toBe(KrbErrorCode.KDC_ERR_BADOPTION);
  });
});

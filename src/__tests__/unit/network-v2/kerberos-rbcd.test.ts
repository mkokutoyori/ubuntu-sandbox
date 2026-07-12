/**
 * Resource-Based Constrained Delegation (RBCD, MS-SFU
 * `msDS-AllowedToActOnBehalfOfOtherIdentity`) — the reverse of classic
 * constrained delegation: the *resource* (backend service) opts specific
 * principals in, rather than the front-end service declaring where it
 * may delegate. Reuses the exact same S4U2Proxy KDC exchange as classic
 * constrained delegation — only the authorization check differs.
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
  dc.getPorts()[0].configureIP(new IPAddress('192.168.98.10'), mask);
  middleSrv.getPorts()[0].configureIP(new IPAddress('192.168.98.11'), mask);
  backendSrv.getPorts()[0].configureIP(new IPAddress('192.168.98.12'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.98.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');

  middleSrv.setCurrentUser('Administrator');
  await run(ps(middleSrv), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.98.10');
  backendSrv.setCurrentUser('Administrator');
  await run(ps(backendSrv), 'Add-Computer -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.98.10');

  return { dc, middleSrv, backendSrv, client };
}

async function attemptS4U2Proxy(dc: WindowsServer, client: WindowsPC) {
  const clientConn = dialKdc(client.getTcpStack(), '192.168.98.10');
  const asAlice = clientConn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
  const aliceToMiddle = clientConn.client!.tgsExchange(
    asAlice.ticket!, asAlice.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'MIDDLE1',
  );
  const evidenceTicket = aliceToMiddle.ticket!;

  const midConn = dialKdc(client.getTcpStack(), '192.168.98.10');
  const midSecret = dc.getDirectoryStore()!.getComputerSecret('MIDDLE1')!;
  const asMiddle = midConn.client!.asExchange('MIDDLE1$', midSecret, 'LAB.LOCAL');

  return midConn.client!.s4u2Proxy(
    asMiddle.ticket!, asMiddle.sessionKey!, principalName(PrincipalNameType.NT_PRINCIPAL, 'MIDDLE1$'), 'LAB.LOCAL',
    evidenceTicket, 'BACKEND1',
  );
}

describe('Resource-Based Constrained Delegation (RBCD)', () => {
  it('allows delegation when the resource lists the delegating computer, with no classic msDS-AllowedToDelegateTo set', async () => {
    const { dc, client } = await buildLab();
    const res = dc.getDirectoryStore()!.setResourceBasedConstrainedDelegation('BACKEND1', ['MIDDLE1']);
    expect(res.ok).toBe(true);
    expect(dc.getDirectoryStore()!.getResourceBasedConstrainedDelegation('BACKEND1')).toEqual(['MIDDLE1']);

    const s4u = await attemptS4U2Proxy(dc, client);
    expect(s4u.ok).toBe(true);
    expect(s4u.ticket?.sname.nameString).toEqual(['BACKEND1']);
  });

  it('rejects delegation when the resource does not list the delegating computer', async () => {
    const { dc, client } = await buildLab();
    dc.getDirectoryStore()!.setResourceBasedConstrainedDelegation('BACKEND1', ['SOMEOTHERSERVICE']);

    const s4u = await attemptS4U2Proxy(dc, client);
    expect(s4u.ok).toBe(false);
    expect(s4u.errorCode).toBe(KrbErrorCode.KDC_ERR_BADOPTION);
  });

  it('fails cleanly when configured against an unknown resource computer', async () => {
    const { dc } = await buildLab();
    const res = dc.getDirectoryStore()!.setResourceBasedConstrainedDelegation('GHOSTHOST', ['MIDDLE1']);
    expect(res.ok).toBe(false);
  });
});

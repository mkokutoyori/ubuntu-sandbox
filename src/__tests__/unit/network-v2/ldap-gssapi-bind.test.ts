/**
 * PRD-Windows-Server-Advanced.md §5 P3 — real LDAP GSSAPI SASL bind (RFC
 * 4511 §4.2): the client obtains a real TGT then a real service ticket for
 * the DC's own computer account via Kerberos (§5 P1/P2), builds an AP-REQ
 * (RFC 4120 §5.5.1), and presents it as SASL credentials instead of a
 * cleartext simple-bind password — validated end-to-end over a real wired
 * topology against `LdapServerHandler`'s GSSAPI path.
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
import { dialKdc, buildApReq } from '@/network/kerberos/KerberosClient';
import { KU_AP_REQ_AUTHENTICATOR } from '@/network/kerberos/crypto';
import { dialLdap } from '@/network/devices/windows/server/ad/ldap/LdapClient';
import { LdapResultCode } from '@/network/devices/windows/server/ad/ldap/LdapMessage';
import { principalName, PrincipalNameType } from '@/network/kerberos/types';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

async function buildLan(): Promise<{ dc: WindowsServer; client: LinuxServer }> {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const sw = new GenericSwitch('switch-generic', 'SW1');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  new Cable('c-client').connect(client.getPorts()[0], sw.getPorts()[1]);
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.53.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.53.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  return { dc, client };
}

describe('LDAP GSSAPI SASL bind — real AP-REQ credentials over TCP/389', () => {
  it('binds successfully with a genuine Kerberos AP-REQ for a valid user', async () => {
    const { dc, client } = await buildLan();

    const kdcConn = dialKdc(client.getTcpStack(), '192.168.53.10');
    const kerb = kdcConn.client!;
    const asResult = kerb.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(asResult.ok).toBe(true);
    const tgsResult = kerb.tgsExchange(
      asResult.ticket!, asResult.sessionKey!,
      principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), 'LAB.LOCAL', dc.getHostname(),
    );
    expect(tgsResult.ok).toBe(true);

    const apReqBytes = buildApReq(
      tgsResult.ticket!, tgsResult.sessionKey!,
      principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), 'LAB.LOCAL', KU_AP_REQ_AUTHENTICATOR,
    );

    const ldapConn = dialLdap(client.getTcpStack(), '192.168.53.10');
    expect(ldapConn.ok).toBe(true);
    const bindRes = ldapConn.client!.bindSasl('GSSAPI', apReqBytes);
    expect(bindRes.ok).toBe(true);
    expect(bindRes.result.resultCode).toBe(LdapResultCode.success);
  });

  it('rejects a GSSAPI bind carrying a forged AP-REQ (wrong ticket session key)', async () => {
    const { dc, client } = await buildLan();
    const kdcConn = dialKdc(client.getTcpStack(), '192.168.53.10');
    const kerb = kdcConn.client!;
    const asResult = kerb.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    const tgsResult = kerb.tgsExchange(
      asResult.ticket!, asResult.sessionKey!,
      principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), 'LAB.LOCAL', dc.getHostname(),
    );

    const forgedApReq = buildApReq(
      tgsResult.ticket!, 'wrong-session-key',
      principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'), 'LAB.LOCAL', KU_AP_REQ_AUTHENTICATOR,
    );

    const ldapConn = dialLdap(client.getTcpStack(), '192.168.53.10');
    const bindRes = ldapConn.client!.bindSasl('GSSAPI', forgedApReq);
    expect(bindRes.ok).toBe(false);
    expect(bindRes.result.resultCode).toBe(LdapResultCode.invalidCredentials);
  });

  it('rejects an unsupported SASL mechanism', async () => {
    const { client } = await buildLan();
    const ldapConn = dialLdap(client.getTcpStack(), '192.168.53.10');
    const bindRes = ldapConn.client!.bindSasl('DIGEST-MD5', new Uint8Array([1, 2, 3]));
    expect(bindRes.ok).toBe(false);
    expect(bindRes.result.resultCode).toBe(LdapResultCode.invalidCredentials);
  });

  it('still permits ordinary simple binds unaffected by the SASL extension', async () => {
    const { client } = await buildLan();
    const ldapConn = dialLdap(client.getTcpStack(), '192.168.53.10');
    const bindRes = ldapConn.client!.bind('Administrator', 'P@ssw0rd');
    expect(bindRes.ok).toBe(true);
  });
});

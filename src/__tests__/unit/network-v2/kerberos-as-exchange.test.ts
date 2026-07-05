/**
 * PRD-Windows-Server-Advanced.md §5 P1 — real Kerberos AS exchange over a
 * real wired topology: `KdcSessionHandler` on a real TCP/88 listener
 * (gated on `Install-ADDSForest` promotion, exactly like the LDAP TCP/389
 * listener), `KerberosClient` dialing across a real cable+switch. Cross-OS
 * per this session's convention: a Linux client authenticating against a
 * Windows Server DC's KDC.
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
import { encodeKdcReq, isKrbError, decodeKrbError } from '@/network/kerberos/codec';
import { principalName, PrincipalNameType, KrbErrorCode } from '@/network/kerberos/types';

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
  dc.getPorts()[0].configureIP(new IPAddress('192.168.50.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.50.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  return { dc, client };
}

describe('Kerberos AS exchange — real KDC-REQ/KDC-REP over a real TCP/88 wire', () => {
  it('completes the full AS exchange (pre-auth challenge, then success) for a valid user/password', async () => {
    const { client } = await buildLan();
    const conn = dialKdc(client.getTcpStack(), '192.168.50.10');
    expect(conn.ok).toBe(true);

    const result = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(result.ok).toBe(true);
    expect(result.sessionKey).toBeTruthy();
    expect(result.ticket?.realm).toBe('LAB.LOCAL');
    expect(result.ticket?.sname.nameString).toEqual(['krbtgt', 'LAB.LOCAL']);
    expect(result.encKdcRepPart?.srealm).toBe('LAB.LOCAL');
    expect(result.encKdcRepPart?.flags.initial).toBe(true);
    expect(result.encKdcRepPart?.flags.preAuthent).toBe(true);
  });

  it('fails pre-authentication for a wrong password', async () => {
    const { client } = await buildLan();
    const conn = dialKdc(client.getTcpStack(), '192.168.50.10');
    const result = conn.client!.asExchange('alice', 'wrongpassword', 'LAB.LOCAL');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KDC_ERR_PREAUTH_FAILED);
  });

  it('rejects an unknown client principal', async () => {
    const { client } = await buildLan();
    const conn = dialKdc(client.getTcpStack(), '192.168.50.10');
    const result = conn.client!.asExchange('nosuchuser', 'whatever', 'LAB.LOCAL');
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe(KrbErrorCode.KDC_ERR_C_PRINCIPAL_UNKNOWN);
  });

  it('requires pre-authentication on the raw wire (KDC_ERR_PREAUTH_REQUIRED) for an AS-REQ with no PA-DATA', async () => {
    const { client } = await buildLan();
    const socket = client.getTcpStack().connect('192.168.50.10', 88);
    expect(socket?.state).toBe('established');

    let reply: Uint8Array | null = null;
    socket!.onData((data) => { if (data instanceof Uint8Array) reply = data; });
    socket!.send(encodeKdcReq({
      msgType: 'AS-REQ', padata: [],
      reqBody: {
        kdcOptions: 0,
        cname: principalName(PrincipalNameType.NT_PRINCIPAL, 'alice'),
        realm: 'LAB.LOCAL',
        sname: principalName(PrincipalNameType.NT_SRV_INST, 'krbtgt', 'LAB.LOCAL'),
        till: Math.floor(Date.now() / 1000) + 3600,
        nonce: 999,
        etype: [18],
      },
    }));

    expect(reply).not.toBeNull();
    expect(isKrbError(reply!)).toBe(true);
    expect(decodeKrbError(reply!).errorCode).toBe(KrbErrorCode.KDC_ERR_PREAUTH_REQUIRED);
  });

  it('refuses to complete an AS exchange until the server is promoted to a domain controller', () => {
    const dc = new WindowsServer('DC2');
    const client = new LinuxServer('linux-server', 'CLIENT2');
    const sw = new GenericSwitch('switch-generic', 'SW2');
    new Cable('c-dc2').connect(dc.getPorts()[0], sw.getPorts()[0]);
    new Cable('c-client2').connect(client.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc.getPorts()[0].configureIP(new IPAddress('192.168.51.10'), mask);
    client.getPorts()[0].configureIP(new IPAddress('192.168.51.20'), mask);

    const conn = dialKdc(client.getTcpStack(), '192.168.51.10');
    const result = conn.client?.asExchange('alice', 'alicepw', 'LAB.LOCAL') ?? { ok: false };
    expect(result.ok).toBe(false);
  });
});

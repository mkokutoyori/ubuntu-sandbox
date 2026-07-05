/**
 * PRD-Windows-Server-Advanced.md §5 P2 — the real Kerberos TGS exchange
 * over a real wired topology: `KdcSessionHandler` handling TGS-REQ (RFC
 * 4120 §3.3), `KerberosClient.tgsExchange` presenting a real TGT plus a
 * fresh Authenticator (PA-TGS-REQ, §5.5.1) to obtain a service ticket for
 * a computer-account SPN. Cross-OS per this session's convention.
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
import { KrbErrorCode } from '@/network/kerberos/types';

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
  dc.getPorts()[0].configureIP(new IPAddress('192.168.52.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.52.20'), mask);

  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  return { dc, client };
}

describe('Kerberos TGS exchange — real TGS-REQ/TGS-REP over a real TCP/88 wire', () => {
  it('obtains a TGT via AS exchange, then a service ticket for the DC\'s own computer account via TGS exchange', async () => {
    const { dc, client } = await buildLan();
    const conn = dialKdc(client.getTcpStack(), '192.168.52.10');
    expect(conn.ok).toBe(true);
    const kerb = conn.client!;

    const asResult = kerb.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(asResult.ok).toBe(true);
    const tgt = asResult.ticket!;
    const tgtSessionKey = asResult.sessionKey!;

    const tgsResult = kerb.tgsExchange(
      tgt, tgtSessionKey,
      { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', dc.getHostname(),
    );
    expect(tgsResult.ok).toBe(true);
    expect(tgsResult.sessionKey).toBeTruthy();
    expect(tgsResult.sessionKey).not.toBe(tgtSessionKey);
    expect(tgsResult.ticket?.sname.nameString).toEqual([dc.getHostname()]);
    expect(tgsResult.encKdcRepPart?.srealm).toBe('LAB.LOCAL');
  });

  it('rejects a TGS-REQ for an unknown service principal', async () => {
    const { client } = await buildLan();
    const conn = dialKdc(client.getTcpStack(), '192.168.52.10');
    const kerb = conn.client!;
    const asResult = kerb.asExchange('alice', 'alicepw', 'LAB.LOCAL');

    const tgsResult = kerb.tgsExchange(
      asResult.ticket!, asResult.sessionKey!,
      { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'NOSUCHHOST',
    );
    expect(tgsResult.ok).toBe(false);
    expect(tgsResult.errorCode).toBe(KrbErrorCode.KDC_ERR_S_PRINCIPAL_UNKNOWN);
  });

  it('rejects a TGS-REQ carrying a forged (wrong-session-key) Authenticator', async () => {
    const { client } = await buildLan();
    const conn = dialKdc(client.getTcpStack(), '192.168.52.10');
    const kerb = conn.client!;
    const asResult = kerb.asExchange('alice', 'alicepw', 'LAB.LOCAL');

    const tgsResult = kerb.tgsExchange(
      asResult.ticket!, 'not-the-real-session-key',
      { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'DC1',
    );
    expect(tgsResult.ok).toBe(false);
    expect(tgsResult.errorCode).toBe(KrbErrorCode.KRB_AP_ERR_TKT_EXPIRED);
  });
});

/**
 * PRD-Windows-Server-Advanced.md §5 P12 — observability transverse to
 * §5 P1-P11: `KdcSessionHandler` publishes `kerberos.*` events and feeds
 * a `KerberosSignalStore` for the AS exchange, the TGS exchange (ordinary
 * service tickets, cross-realm referrals §5 P9, S4U2Proxy delegation
 * §5 P10); `replicateFrom`/`ReplicationServerHandler` do the same for
 * `replication.*` and a `ReplicationSignalStore`.
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
import type { KerberosDomainEvent } from '@/network/kerberos/events';
import type { ReplicationDomainEvent } from '@/network/devices/windows/server/ad/replication/events';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  Logger.reset();
});

const ps = (d: WindowsServer) => PowerShellSubShell.create(d).subShell;
const run = async (sh: ReturnType<typeof ps>, l: string) => (await sh.processLine(l)).output.join('\n');

function collect<T extends KerberosDomainEvent['topic'] | ReplicationDomainEvent['topic']>(
  publisher: WindowsServer, topic: T,
): unknown[] {
  const out: unknown[] = [];
  publisher.getBus().subscribe(topic as never, (e: { payload: unknown }) => out.push(e.payload));
  return out;
}

async function buildLab(): Promise<{ dc: WindowsServer; client: LinuxServer; cClient: Cable }> {
  const dc = new WindowsServer('DC1');
  const client = new LinuxServer('linux-server', 'CLIENT1');
  const mask = new SubnetMask('255.255.255.0');
  dc.getPorts()[0].configureIP(new IPAddress('192.168.97.10'), mask);
  client.getPorts()[0].configureIP(new IPAddress('192.168.97.11'), mask);
  const sw = new GenericSwitch('switch-generic', 'SW1');
  const cClient = new Cable('c-client');
  new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
  cClient.connect(client.getPorts()[0], sw.getPorts()[1]);
  dc.setCurrentUser('Administrator');
  await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
  await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');
  await run(ps(dc), 'New-ADUser -Name alice -AccountPassword (ConvertTo-SecureString "alicepw" -AsPlainText -Force) -DisplayName "Alice"');
  return { dc, client, cClient };
}

describe('Kerberos observability (§5 P12) — AS exchange', () => {
  it('records a succeeded AS exchange in both the signal store and the event bus', async () => {
    const { dc, client, cClient } = await buildLab();
    const succeeded = collect(dc, 'kerberos.as.succeeded');
    const framesBefore = cClient.getStats().framesTransmitted;

    const conn = dialKdc(client.getTcpStack(), '192.168.97.10');
    const res = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    expect(res.ok).toBe(true);

    // Correction (§5 P12): the observability signals ride on top of the AS
    // exchange's real TCP/88 traffic — assert it genuinely crossed the
    // client's physical Cable (no shortcut bypassing Port/Cable delivery).
    expect(cClient.getStats().framesTransmitted).toBeGreaterThan(framesBefore);
    expect(succeeded).toHaveLength(1);
    expect(dc.getKerberosSignals().stats.get().asSucceeded).toBe(1);
    expect(dc.getKerberosSignals().log.get().some(e => e.kind === 'as-succeeded' && e.cname === 'alice')).toBe(true);
  });

  it('records a failed AS exchange (bad password) but not the routine PREAUTH_REQUIRED round-trip', async () => {
    const { dc, client } = await buildLab();
    const failed = collect(dc, 'kerberos.as.failed');

    const conn = dialKdc(client.getTcpStack(), '192.168.97.10');
    const res = conn.client!.asExchange('alice', 'wrongpassword', 'LAB.LOCAL');
    expect(res.ok).toBe(false);

    expect(failed).toHaveLength(1);
    expect(dc.getKerberosSignals().stats.get().asFailed).toBe(1);
  });
});

describe('Kerberos observability (§5 P12) — TGS exchange', () => {
  it('records a succeeded (non-referral) TGS exchange', async () => {
    const { dc, client } = await buildLab();
    const succeeded = collect(dc, 'kerberos.tgs.succeeded');

    const conn = dialKdc(client.getTcpStack(), '192.168.97.10');
    const as = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    const tgs = conn.client!.tgsExchange(as.ticket!, as.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'DC1');
    expect(tgs.ok).toBe(true);

    expect(succeeded).toHaveLength(1);
    expect((succeeded[0] as { referral: boolean }).referral).toBe(false);
    expect(dc.getKerberosSignals().stats.get().tgsSucceeded).toBe(1);
    expect(dc.getKerberosSignals().stats.get().tgsReferralsIssued).toBe(0);
  });

  it('records a failed TGS exchange (unknown service)', async () => {
    const { dc, client } = await buildLab();
    const failed = collect(dc, 'kerberos.tgs.failed');

    const conn = dialKdc(client.getTcpStack(), '192.168.97.10');
    const as = conn.client!.asExchange('alice', 'alicepw', 'LAB.LOCAL');
    const tgs = conn.client!.tgsExchange(as.ticket!, as.sessionKey!, { nameType: 1, nameString: ['alice'] }, 'LAB.LOCAL', 'NOSUCHHOST');
    expect(tgs.ok).toBe(false);

    expect(failed).toHaveLength(1);
    expect(dc.getKerberosSignals().stats.get().tgsFailed).toBe(1);
  });
});

describe('AD replication observability (§5 P12)', () => {
  it('records a succeeded pull cycle in both the signal store and the event bus', async () => {
    const dc1 = new WindowsServer('DC1');
    const dc2 = new WindowsServer('DC2');
    const sw = new GenericSwitch('switch-generic', 'SW1');
    const cDc1 = new Cable('c-dc1');
    const cDc2 = new Cable('c-dc2');
    cDc1.connect(dc1.getPorts()[0], sw.getPorts()[0]);
    cDc2.connect(dc2.getPorts()[0], sw.getPorts()[1]);
    const mask = new SubnetMask('255.255.255.0');
    dc1.getPorts()[0].configureIP(new IPAddress('192.168.97.20'), mask);
    dc2.getPorts()[0].configureIP(new IPAddress('192.168.97.21'), mask);

    dc1.setCurrentUser('Administrator');
    await run(ps(dc1), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc1), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    dc2.setCurrentUser('Administrator');
    await run(ps(dc2), 'Install-WindowsFeature AD-Domain-Services');
    const completed = collect(dc2, 'replication.pull.completed');
    const framesBefore = cDc2.getStats().framesTransmitted;
    await run(
      ps(dc2),
      'Install-ADDSDomainController -DomainName lab.local -Credential "Administrator:P@ssw0rd" -Server 192.168.97.20 '
      + '-SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)',
    );

    // Correction (§5 P12): the replication signals ride on top of the
    // initial-sync's real TCP/135 pull — assert it genuinely crossed dc2's
    // physical Cable (no shortcut bypassing Port/Cable delivery).
    expect(cDc2.getStats().framesTransmitted).toBeGreaterThan(framesBefore);
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(dc2.getReplicationSignals().stats.get().pullsSucceeded).toBeGreaterThanOrEqual(1);
  });

  it('records a failed pull cycle when the partner is unreachable', async () => {
    const dc = new WindowsServer('DC1');
    dc.getPorts()[0].configureIP(new IPAddress('192.168.97.30'), new SubnetMask('255.255.255.0'));
    const sw = new GenericSwitch('switch-generic', 'SW1');
    new Cable('c-dc').connect(dc.getPorts()[0], sw.getPorts()[0]);
    dc.setCurrentUser('Administrator');
    await run(ps(dc), 'Install-WindowsFeature AD-Domain-Services');
    await run(ps(dc), 'Install-ADDSForest -DomainName lab.local -SafeModeAdministratorPassword (ConvertTo-SecureString "P@ssw0rd" -AsPlainText -Force)');

    const failed = collect(dc, 'replication.pull.failed');
    const result = dc.replicateFrom('192.168.97.99');
    expect(result.ok).toBe(false);

    expect(failed).toHaveLength(1);
    expect(dc.getReplicationSignals().stats.get().pullsFailed).toBe(1);
  });
});

/**
 * IKEv2 DPD (RFC 7296 §2.4) and lifetime-based rekey (RFC 7296 §2.8) were
 * dead: recheckIKESALifetimes()/runDPDCheck() only ever iterated the IKEv1
 * SA database, and IKEv2_SA had no dpdEnabled/lastDPDActivity/lifetime
 * fields at all — so `crypto ikev2 dpd`, `crypto ikev2 nat keepalive`, and
 * a profile's `dpd`/`lifetime` sub-commands had zero effect: an IKEv2
 * tunnel never expired and never detected a dead peer, no matter what was
 * configured. Mirrors ipsec-dpd-wire.test.ts's IKEv1 coverage.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { IKEv2_SA } from '@/network/ipsec/IPSecTypes';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildTunnel(opts: { dpd?: 'global' | 'profile'; lifetime?: number } = {}) {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const wan = new Cable('wan');
  wan.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  for (const [router, outside, peer] of [
    [r1, '10.0.12.1', '10.0.12.2'],
    [r2, '10.0.12.2', '10.0.12.1'],
  ] as [CiscoRouter, string, string][]) {
    const profileDpdCmds = opts.dpd === 'profile' ? ['dpd 10 3 periodic'] : [];
    const lifetimeCmds = opts.lifetime ? [`lifetime ${opts.lifetime}`] : [];
    await run(router, [
      'enable', 'configure terminal',
      'interface GigabitEthernet0/1', `ip address ${outside} 255.255.255.252`, 'no shutdown', 'exit',
      'crypto ikev2 proposal PROP', 'encryption aes-cbc-256', 'integrity sha256', 'group 14', 'exit',
      'crypto ikev2 policy POL', 'proposal PROP', 'exit',
      'crypto ikev2 keyring KR', 'peer P', `address ${peer}`, 'pre-shared-key WireDpd1', 'exit', 'exit',
      'crypto ikev2 profile PROF',
      `match identity remote address ${peer} 255.255.255.255`,
      'authentication remote pre-share', 'authentication local pre-share',
      'keyring local KR',
      ...profileDpdCmds, ...lifetimeCmds,
      'exit',
      'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
      'ip access-list extended VPN_ACL', `permit ip host ${outside} host ${peer}`, 'exit',
      'crypto map CMAP 10 ipsec-isakmp', `set peer ${peer}`, 'set ikev2-profile PROF',
      'set transform-set TSET', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end',
    ]);
  }

  await r1.executeCommand('ping 10.0.12.2');
  return { r1, r2, wan };
}

function ikev2Sa(router: CiscoRouter, peerIp: string): IKEv2_SA | undefined {
  const engine = (router as unknown as { _getIPSecEngineInternal(): unknown })
    ._getIPSecEngineInternal() as { ikev2SADB: Map<string, IKEv2_SA> } | null;
  return (engine as unknown as { ikev2SADB: Map<string, IKEv2_SA> })?.ikev2SADB?.get(peerIp);
}

function runDpd(router: CiscoRouter): string[] {
  const engine = (router as unknown as { _getIPSecEngineInternal(): { runDPDCheck(): string[] } })
    ._getIPSecEngineInternal();
  return engine.runDPDCheck();
}

function recheckLifetimes(router: CiscoRouter): void {
  const engine = (router as unknown as { _getIPSecEngineInternal(): { recheckIKESALifetimes(): void } })
    ._getIPSecEngineInternal();
  engine.recheckIKESALifetimes();
}

describe('IKEv2 DPD and lifetime-based rekey', () => {
  it('a real IKEv2 SA forms and carries no DPD config by default (no crypto ikev2 dpd configured)', async () => {
    const { r1 } = await buildTunnel();
    const sa = ikev2Sa(r1, '10.0.12.2');
    expect(sa?.status).toBe('READY');
    expect(sa?.dpdEnabled).toBe(false);
  });

  it('global "crypto ikev2 dpd" enables DPD on the SA, and a live peer ACKs the probe with no timeout', async () => {
    const { r1 } = await buildTunnel();
    await r1.executeCommand('enable');
    await r1.executeCommand('configure terminal');
    await r1.executeCommand('crypto ikev2 dpd 10 3 periodic');
    await r1.executeCommand('end');
    // Global config only takes effect on a fresh negotiation.
    await r1.executeCommand('clear crypto session');
    await r1.executeCommand('ping 10.0.12.2');

    const sa = ikev2Sa(r1, '10.0.12.2')!;
    expect(sa.dpdEnabled).toBe(true);
    sa.lastDPDActivity = Date.now() - 60_000;
    runDpd(r1);
    expect(sa.dpdTimeouts ?? 0).toBe(0);
    expect(sa.dpdSeq).toBeGreaterThan(0);
  });

  it('a profile-level "dpd" sub-command enables DPD without any global config', async () => {
    const { r1 } = await buildTunnel({ dpd: 'profile' });
    const sa = ikev2Sa(r1, '10.0.12.2')!;
    expect(sa.dpdEnabled).toBe(true);
    expect(sa.dpdIntervalSec).toBe(10);
    expect(sa.dpdRetries).toBe(3);
  });

  it('a cut cable makes consecutive IKEv2 DPD probes time out and clears the SA', async () => {
    const { r1, wan } = await buildTunnel({ dpd: 'profile' });
    const sa = ikev2Sa(r1, '10.0.12.2')!;
    wan.disconnect();

    for (let i = 0; i < 3; i++) {
      sa.lastDPDActivity = Date.now() - 60_000;
      runDpd(r1);
    }

    expect(ikev2Sa(r1, '10.0.12.2')).toBeUndefined();
    const show = await r1.executeCommand('show crypto ikev2 sa');
    expect(show).not.toContain('READY');
  });

  it('a profile "lifetime" expiring triggers a real rekey (new SPI, fresh timestamp)', async () => {
    const { r1 } = await buildTunnel({ lifetime: 120 });
    const before = ikev2Sa(r1, '10.0.12.2')!;
    expect(before.lifetime).toBe(120);
    const oldSpi = before.spiLocal;
    before.created = Date.now() - 121_000;

    recheckLifetimes(r1);

    const after = ikev2Sa(r1, '10.0.12.2')!;
    expect(after.spiLocal).not.toBe(oldSpi);
    expect(after.status).toBe('READY');
    expect(Date.now() - after.created).toBeLessThan(1000);
  });

  it('an unexpired SA is left alone by the lifetime check', async () => {
    const { r1 } = await buildTunnel({ lifetime: 3600 });
    const before = ikev2Sa(r1, '10.0.12.2')!;
    const oldSpi = before.spiLocal;

    recheckLifetimes(r1);

    const after = ikev2Sa(r1, '10.0.12.2')!;
    expect(after.spiLocal).toBe(oldSpi);
  });
});

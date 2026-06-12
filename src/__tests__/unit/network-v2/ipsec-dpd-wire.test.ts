// DPD R-U-THERE/ACK must travel as real UDP 500 datagrams (journal entrée 17).

import { describe, it, expect, beforeEach } from 'vitest';
import { CiscoRouter } from '@/network/devices/CiscoRouter';
import { Cable } from '@/network/hardware/Cable';
import { MACAddress, resetCounters } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import type { IKE_SA } from '@/network/ipsec/IPSecTypes';

beforeEach(() => {
  resetCounters();
  resetDeviceCounters();
  MACAddress.resetCounter();
  Logger.reset();
});

interface Cmd { executeCommand(cmd: string): Promise<string> }
const run = (d: Cmd, cmds: string[]) =>
  cmds.reduce(async (p, c) => { await p; await d.executeCommand(c); }, Promise.resolve<unknown>(undefined));

async function buildTunnel() {
  const r1 = new CiscoRouter('R1');
  const r2 = new CiscoRouter('R2');
  const wan = new Cable('wan');
  wan.connect(r1.getPort('GigabitEthernet0/1')!, r2.getPort('GigabitEthernet0/1')!);

  for (const [router, outside, peer] of [
    [r1, '10.0.12.1', '10.0.12.2'],
    [r2, '10.0.12.2', '10.0.12.1'],
  ] as [CiscoRouter, string, string][]) {
    await run(router, ['enable', 'configure terminal',
      'interface GigabitEthernet0/1', `ip address ${outside} 255.255.255.252`, 'no shutdown', 'exit',
      'crypto isakmp policy 10', 'encryption aes 256', 'hash sha256',
      'authentication pre-share', 'group 14', 'exit',
      `crypto isakmp key WireDpd1 address ${peer}`,
      'crypto isakmp keepalive 10 3 periodic',
      'crypto ipsec transform-set TSET esp-aes 256 esp-sha256-hmac', 'mode tunnel', 'exit',
      'ip access-list extended VPN_ACL', `permit ip host ${outside} host ${peer}`, 'exit',
      'crypto map CMAP 10 ipsec-isakmp', `set peer ${peer}`,
      'set transform-set TSET', 'match address VPN_ACL', 'exit',
      'interface GigabitEthernet0/1', 'crypto map CMAP', 'exit', 'end']);
  }

  await r1.executeCommand(`ping 10.0.12.2`);
  return { r1, r2, wan };
}

function ikeSa(router: CiscoRouter, peerIp: string): IKE_SA | undefined {
  const engine = (router as unknown as { _getIPSecEngineInternal(): unknown })
    ._getIPSecEngineInternal() as { ikeSADB: Map<string, IKE_SA> } | null;
  return (engine as unknown as { ikeSADB: Map<string, IKE_SA> })?.ikeSADB?.get(peerIp);
}

function rewindDpd(sa: IKE_SA): void {
  sa.lastDPDActivity = Date.now() - 60_000;
}

function runDpd(router: CiscoRouter): string[] {
  const engine = (router as unknown as { _getIPSecEngineInternal(): { runDPDCheck(): string[] } })
    ._getIPSecEngineInternal();
  return engine.runDPDCheck();
}

describe('IPSec DPD over the wire', () => {
  it('a live peer ACKs the R-U-THERE probe — no timeout accrues', async () => {
    const { r1 } = await buildTunnel();
    const sa = ikeSa(r1, '10.0.12.2');
    expect(sa?.status).toBe('QM_IDLE');

    rewindDpd(sa!);
    runDpd(r1);

    expect(sa!.dpdTimeouts ?? 0).toBe(0);
    expect(sa!.dpdSeq).toBeGreaterThan(0);
  });

  it('a cut cable makes consecutive probes time out and clears the SAs', async () => {
    const { r1, wan } = await buildTunnel();
    const sa = ikeSa(r1, '10.0.12.2')!;
    wan.disconnect();

    for (let i = 0; i < 3; i++) {
      rewindDpd(sa);
      runDpd(r1);
    }

    expect(ikeSa(r1, '10.0.12.2')).toBeUndefined();
    const show = await r1.executeCommand('show crypto isakmp sa');
    expect(show).not.toContain('QM_IDLE');
  });

  it('the ACK must echo the probe sequence number', async () => {
    const { r1 } = await buildTunnel();
    const sa = ikeSa(r1, '10.0.12.2')!;

    rewindDpd(sa);
    runDpd(r1);
    const seqAfterFirst = sa.dpdSeq!;
    rewindDpd(sa);
    runDpd(r1);

    expect(sa.dpdSeq).toBe(seqAfterFirst + 1);
    expect(sa.dpdTimeouts ?? 0).toBe(0);
  });
});

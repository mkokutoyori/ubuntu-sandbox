/**
 * Cisco IOS Security Command Reference (official_docs/cisco/ios-security, Commands A to C):
 * `crypto isakmp enable` (default on; the no form disables IKE) and `crypto ipsec optional`
 * (passive mode: the router accepts clear text as well as IPsec traffic).
 *
 *   no crypto isakmp enable   the router neither starts nor answers IKE negotiations
 *   crypto ipsec optional     without it, a clear packet received on a crypto-map interface that
 *                             the crypto ACL would have protected is dropped (IOS logs
 *                             %CRYPTO-4-RECVD_PKT_NOT_IPSEC); with it, it is forwarded
 *
 * Lab: ipsecLab. IKE is observed on the wire (UDP/500 leaving R1's WAN port). The clear packet is
 * a real echo request: R2 loses its crypto map, so PC2's ping crosses the WAN in clear and R1's
 * LAN port is tapped to see whether the request is forwarded to PC1.
 *
 * Measured with src stashed to HEAD: `crypto isakmp enable` and `crypto ipsec optional` are
 * refused, IKE always runs and R1 forwards the clear request, so 6 of the 7 cases fall. The one
 * that passes either way is the witness (the tunnel comes up by default).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import type { EthernetFrame, IPv4Packet } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { ipsecLab, countIke } from './_helpers/ipsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const ping = (lab: Awaited<ReturnType<typeof ipsecLab>>) =>
  clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'));

function echoRequestsToPc1(lab: Awaited<ReturnType<typeof ipsecLab>>): { count: number } {
  const seen = { count: 0 };
  lab.r1.getPort('GigabitEthernet0/0')!.attachTap(({ direction, frame }: { direction: string; frame: EthernetFrame }) => {
    if (direction !== 'out') return;
    const packet = frame.payload as IPv4Packet | undefined;
    const icmp = packet?.type === 'ipv4' ? packet.payload as { type?: string; icmpType?: number; code?: number } : undefined;
    if (icmp?.type === 'icmp' && packet?.sourceIP.toString() === '192.168.2.10') seen.count++;
  });
  return seen;
}

describe('crypto isakmp enable', () => {
  it('witness: by default the tunnel comes up', async () => {
    const lab = await ipsecLab();
    expect(await ping(lab)).toContain('1 received');
  });

  it('no crypto isakmp enable on the initiator: nothing is sent on UDP/500 and the tunnel never comes up', async () => {
    const lab = await ipsecLab(['no crypto isakmp enable']);
    const ike = countIke(lab);
    expect(await ping(lab)).not.toContain('1 received');
    expect(ike.count).toBe(0);
  });

  it('no crypto isakmp enable on the responder: the initiator tries, nobody answers', async () => {
    const lab = await ipsecLab();
    await lab.r2.executeCommand('configure terminal');
    await lab.r2.executeCommand('no crypto isakmp enable');
    const ike = countIke(lab);
    expect(await ping(lab)).not.toContain('1 received');
    expect(ike.count).toBeGreaterThan(0);
    expect(await lab.r1.executeCommand('show crypto isakmp sa')).not.toContain('QM_IDLE');
  });

  it('the no form is rendered, and enabling again brings the tunnel back', async () => {
    const lab = await ipsecLab(['no crypto isakmp enable']);
    expect(await lab.r1.executeCommand('show running-config')).toMatch(/^no crypto isakmp enable$/m);
    await lab.r1.executeCommand('configure terminal');
    await lab.r1.executeCommand('crypto isakmp enable');
    await lab.r1.executeCommand('end');
    expect(await lab.r1.executeCommand('show running-config')).not.toContain('crypto isakmp enable');
    expect(await ping(lab)).toContain('1 received');
  });
});

describe('crypto ipsec optional', () => {
  async function clearTextLab(extraR1: string[] = []) {
    const lab = await ipsecLab(extraR1);
    await lab.r2.executeCommand('configure terminal');
    await lab.r2.executeCommand('interface GigabitEthernet0/1');
    await lab.r2.executeCommand('no crypto map');
    await lab.r2.executeCommand('end');
    return lab;
  }

  it('without it a clear packet the crypto ACL would have protected is dropped and logged', async () => {
    const lab = await clearTextLab();
    const forwarded = echoRequestsToPc1(lab);
    await clock.advanceUntilSettled(lab.pc2.executeCommand('ping -c 1 192.168.1.10'));
    expect(forwarded.count).toBe(0);
    expect(await lab.r1.executeCommand('show logging')).toContain('RECVD_PKT_NOT_IPSEC');
  });

  it('with it the same clear packet is forwarded', async () => {
    const lab = await clearTextLab(['crypto ipsec optional']);
    const forwarded = echoRequestsToPc1(lab);
    await clock.advanceUntilSettled(lab.pc2.executeCommand('ping -c 1 192.168.1.10'));
    expect(forwarded.count).toBeGreaterThan(0);
    expect(await lab.r1.executeCommand('show running-config')).toMatch(/^crypto ipsec optional$/m);
  });

  it('the no form restores the drop', async () => {
    const lab = await clearTextLab(['crypto ipsec optional', 'no crypto ipsec optional']);
    const forwarded = echoRequestsToPc1(lab);
    await clock.advanceUntilSettled(lab.pc2.executeCommand('ping -c 1 192.168.1.10'));
    expect(forwarded.count).toBe(0);
    expect(await lab.r1.executeCommand('show running-config')).not.toContain('crypto ipsec optional');
  });
});

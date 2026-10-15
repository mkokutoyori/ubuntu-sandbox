/**
 * Cisco IOS Security Command Reference: `crypto ipsec optional` and `crypto ipsec optional retry
 * seconds`. Book: in passive mode a packet that matches the crypto map may be routed in the clear
 * while no IPsec session exists, and `retry` is the time a connection can exist in the clear before
 * another attempt is made to establish an encrypted session (default 5 minutes); the command needs
 * `crypto ipsec optional` first.
 *
 * Lab: ipsecLab where R2 does not answer IKE (`no crypto isakmp enable`) and accepts clear text. The
 * tap on R1's WAN port counts the UDP/500 datagrams it sends: a retry is a new IKE attempt on the wire.
 *
 * Measured with src stashed to HEAD: 4 of the 6 cases fall (the clear ping was dropped, no retry timer existed, the
 * retry command was refused). Two pass either way: the witness (without `crypto ipsec optional` the ping is dropped)
 * and the case where the peer answers (the tunnel replaces the clear traffic, non-regression).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resetCounters, MACAddress } from '@/network/core/types';
import { resetDeviceCounters } from '@/network/devices/DeviceFactory';
import { Logger } from '@/network/core/Logger';
import { installVirtualClock } from '@/__tests__/support/ntpTime';
import type { VirtualTimeScheduler } from '@/events/Scheduler';
import { ipsecLab, countIke, type IpsecLab } from './_helpers/ipsecLab';

let clock: VirtualTimeScheduler;

beforeEach(() => {
  resetCounters(); resetDeviceCounters(); MACAddress.resetCounter(); Logger.reset();
  clock = installVirtualClock();
});

const ping = (lab: IpsecLab) => clock.advanceUntilSettled(lab.pc1.executeCommand('ping -c 1 192.168.2.10'));

async function configure(lab: IpsecLab, router: 'r1' | 'r2', ...lines: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const line of ['enable', 'configure terminal', ...lines, 'end']) out.push(await lab[router].executeCommand(line));
  return out;
}

async function silentPeerLab(r1Lines: string[]): Promise<IpsecLab> {
  const lab = await ipsecLab();
  await configure(lab, 'r2', 'no crypto isakmp enable', 'crypto ipsec optional');
  await configure(lab, 'r1', ...r1Lines);
  return lab;
}

describe('crypto ipsec optional retry', () => {
  it('witness (passes either way): without passive mode the ping towards a silent peer is dropped', async () => {
    const lab = await silentPeerLab([]);
    expect(await ping(lab)).toContain('0 received');
  });

  it('in passive mode the traffic is routed in the clear while no session exists', async () => {
    const lab = await silentPeerLab(['crypto ipsec optional']);
    expect(await ping(lab)).toContain('1 received');
    expect(lab.wire.length).toBe(0);
  });

  it('IKE is not attempted again before the retry time (default 300 s)', async () => {
    const lab = await silentPeerLab(['crypto ipsec optional']);
    const ike = countIke(lab);
    await ping(lab);
    const first = ike.count;
    expect(first).toBeGreaterThan(0);
    await clock.advance(120_000);
    await ping(lab);
    expect(ike.count).toBe(first);
    await clock.advance(200_000);
    await ping(lab);
    expect(ike.count).toBeGreaterThan(first);
  });

  it('retry 60 shortens the wait', async () => {
    const lab = await silentPeerLab(['crypto ipsec optional', 'crypto ipsec optional retry 60']);
    const ike = countIke(lab);
    await ping(lab);
    const first = ike.count;
    await clock.advance(30_000);
    await ping(lab);
    expect(ike.count).toBe(first);
    await clock.advance(40_000);
    await ping(lab);
    expect(ike.count).toBeGreaterThan(first);
  });

  it('retry needs passive mode and is read back by the running-config; no retry restores 300', async () => {
    const lab = await ipsecLab();
    const refused = await configure(lab, 'r1', 'crypto ipsec optional retry 60');
    expect(refused.join('\n')).toContain('crypto ipsec optional');
    expect(await lab.r1.executeCommand('show running-config')).not.toContain('optional retry');
    await configure(lab, 'r1', 'crypto ipsec optional', 'crypto ipsec optional retry 60');
    expect(await lab.r1.executeCommand('show running-config')).toContain('crypto ipsec optional retry 60');
    await configure(lab, 'r1', 'no crypto ipsec optional retry');
    expect(await lab.r1.executeCommand('show running-config')).not.toContain('optional retry');
  });

  it('when the peer answers, the tunnel replaces the clear traffic', async () => {
    const lab = await ipsecLab(['crypto ipsec optional']);
    expect(await ping(lab)).toContain('1 received');
    expect(lab.wire.length).toBeGreaterThan(0);
  });
});
